"""Dimension-aligned judge-quality + agreement metrics for the Results page.

Each AI judge is validated against the human panel *for the same dimension* — AI correctness vs
human correctness, AI safety vs human safety — never against a single generic pass/fail. Human
verdicts carry `Judgment.judge_key` (the dimension), 1-1 with the enabled AI judges. Legacy human
rows (judge_key = null, from before per-dimension review) fold into the project's primary
dimension so old projects keep working.

For every dimension we answer, in order:
  1. Do the humans agree on the rubric?  → inter-reviewer Krippendorff's α (that dimension only),
     shown first; a low value flags an ambiguous rubric and caps the judge's readiness.
  2. Does the AI agree with the human panel?  → confusion matrix + class-balanced metrics
     (balanced accuracy, MCC, κ, specificity) with class counts and a bootstrap 95% CI.
  3. Is the judge calibrated?  → signed pass-rate bias → lenient / harsh / balanced, reported
     separately from agreement.
  4. Is it ready?  → a multi-signal gate (sample size, human agreement, class balance,
     single-class behaviour, failure detection, agreement) — never one metric alone.

All statistics live in metrics_math (pure, unit-tested); this module only shapes DB rows.
"""

from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from server.database import (
    DisagreementReview,
    Item,
    JudgmentKind,
    Project,
    ProjectJudge,
    ProjectScale,
)
from server.services import metrics_math as MM

# Below this many gold-labeled units for a dimension, metrics are noisy — the UI shows a caveat.
SMALL_SAMPLE = MM.MIN_GOLD_FOR_GATE

_LABELS = {
    "correctness": "Correctness", "relevance": "Relevance", "safety": "Safety",
    "groundedness": "Groundedness", "guidelines": "Guidelines", "custom": "Custom",
    "overall": "Overall",
}


def _dim_label(key: str) -> str:
    return _LABELS.get(key, key[:1].upper() + key[1:])


def _human_gold_binary(verdicts: list[int]) -> int | None:
    """Human panel majority (1=pass, 0=fail). Ties break to pass. None when nobody graded it."""
    if not verdicts:
        return None
    return 1 if sum(verdicts) * 2 >= len(verdicts) else 0


def project_metrics(db: Session, project_id: str) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}
    is_likert = project.scale == ProjectScale.LIKERT
    level = "ordinal" if is_likert else "nominal"

    enabled = [pj.judge_key for pj in
               db.query(ProjectJudge).filter(ProjectJudge.project_id == project_id).all()
               if pj.enabled]
    items = db.query(Item).filter(Item.project_id == project_id).all()

    # --- first pass: collect raw verdicts per response, per rater/dimension --------------------
    # response_id -> {"human": {dim: {rater_id: value}}, "ai": {dim: value}, "has_key": bool,
    #                 "meta": {...}}
    rows: dict[str, dict] = {}
    llm_dims: list[str] = []
    human_dims_explicit: set[str] = set()
    has_null_human = False
    reviewer_ids: set[str] = set()
    n_responses = 0

    for it in items:
        has_key = bool(it.expected_answer)
        for r in it.responses:
            n_responses += 1
            human: dict[str, dict[str, float]] = defaultdict(dict)
            ai: dict[str, float] = {}
            ai_rationale: dict[str, str] = {}
            for j in r.judgments:
                if j.kind == JudgmentKind.LLM:
                    key = j.judge_key or "overall"
                    if key not in llm_dims:
                        llm_dims.append(key)
                    v = _value(j, is_likert)
                    if v is not None:
                        ai[key] = v
                        ai_rationale[key] = j.rationale or ""
                else:
                    if not j.rater_id:
                        continue
                    reviewer_ids.add(j.rater_id)
                    if j.judge_key:
                        human_dims_explicit.add(j.judge_key)
                    else:
                        has_null_human = True
                    v = _value(j, is_likert)
                    if v is not None:
                        human[j.judge_key or "\x00null"][j.rater_id] = v
            rows[r.id] = {"item": it, "response": r, "has_key": has_key,
                          "human": human, "ai": ai, "ai_rationale": ai_rationale}

    # --- resolve the dimension set + primary ---------------------------------------------------
    dims = list(dict.fromkeys(enabled + llm_dims + sorted(human_dims_explicit)))
    if not dims and (has_null_human or reviewer_ids):
        dims = ["overall"]
    primary = "correctness" if "correctness" in dims else (dims[0] if dims else None)

    # Fold legacy null-dimension human verdicts into the primary dimension.
    if primary:
        for rid, rec in rows.items():
            legacy = rec["human"].pop("\x00null", None)
            if legacy:
                rec["human"].setdefault(primary, {}).update(legacy)

    # Saved gold-label audits: (response_id, dimension) -> category. Used to adjudicate the
    # ground truth before scoring (flip confirmed-bad gold labels, drop unadjudicable items).
    audit_map: dict[tuple[str, str], str] = {}
    if rows:
        for a in (db.query(DisagreementReview)
                  .filter(DisagreementReview.response_id.in_(list(rows.keys()))).all()):
            audit_map[(a.response_id, a.judge_key)] = a.category.value

    # --- per-dimension scorecards --------------------------------------------------------------
    dim_cards = [_dimension_card(dims_key, rows, is_likert, level, audit_map) for dims_key in dims]

    n_reviewers = len(reviewer_ids)
    return {
        "scale": project.scale.value,
        "level": level,
        "small_sample_threshold": SMALL_SAMPLE,
        "n_items": len(items),
        "n_responses": n_responses,
        "n_reviewers": n_reviewers,
        "n_dimensions": len(dims),
        "primary_dimension": primary,
        "answer_key_coverage": {
            "with_key": sum(1 for it in items if it.expected_answer),
            "total": len(items),
        },
        # A single reviewer can't produce a panel-agreement statistic — say so explicitly rather
        # than presenting a meaningless number.
        "panel_agreement_computable": n_reviewers >= 2,
        "dimensions": dim_cards,
    }


_ADJ_EXCLUDE = {"ambiguous_question", "ambiguous_rubric", "different_interpretation",
                "insufficient_evidence"}


def _dimension_card(key: str, rows: dict, is_likert: bool, level: str,
                    audit_map: dict[tuple[str, str], str]) -> dict:
    label = _dim_label(key)

    # Inter-reviewer agreement for THIS dimension (humans only).
    human_units = [list(rec["human"][key].values()) for rec in rows.values()
                   if rec["human"].get(key)]
    n_raters_dim = len({rid for rec in rows.values() for rid in rec["human"].get(key, {})})
    multi = [u for u in human_units if len(u) >= 2]
    alpha = MM.krippendorff_alpha(multi, level) if multi else None
    alpha_ci = _alpha_ci(multi, level) if len(multi) >= 3 else [None, None]
    human = {
        "n_raters": n_raters_dim,
        "n_multi_rated": len(multi),
        "alpha": _round(alpha),
        "alpha_ci": [_round(alpha_ci[0]), _round(alpha_ci[1])],
        "computable": len(multi) > 0 and n_raters_dim >= 2,
        "level": MM.agreement_label(alpha) if (len(multi) and n_raters_dim >= 2) else "n/a",
    }

    # Human panel label + AI prediction, aligned per response (keep response_id for adjudication).
    triples: list[tuple[str, float, float]] = []
    for rid, rec in rows.items():
        hvals = list(rec["human"].get(key, {}).values())
        if not hvals:
            continue
        g = (sum(hvals) / len(hvals)) if is_likert else _human_gold_binary([int(v) for v in hvals])
        if g is None:
            continue
        p = rec["ai"].get(key)
        if p is None:
            continue
        triples.append((rid, float(g), float(p)))

    n_gold = len(triples)
    has_ai = any(rec["ai"].get(key) is not None for rec in rows.values())
    card: dict = {
        "key": key, "label": label, "human": human,
        "n_gold": n_gold, "has_ai_judge": has_ai,
        "small_sample": n_gold < SMALL_SAMPLE,
        "audited": sum(1 for (_rid, k) in audit_map if k == key),
    }
    if not has_ai or n_gold == 0:
        card["ai_vs_human"] = None
        card["ai_vs_human_adjudicated"] = None
        card["audit"] = None
        card["gate"] = {"verdict": "insufficient", "warnings": [],
                        "reason": ("No AI judge for this dimension yet."
                                   if not has_ai else "No overlapping human + AI labels yet.")}
        return card

    # Adjudicate against the gold-label audit: flip confirmed-bad gold labels to the AI's value
    # (the AI was right), drop unadjudicable items, keep everything else. The gate uses the
    # adjudicated numbers ONLY when every disagreement is classified (see `full`).
    is_dis = (lambda g, p: abs(g - p) >= 2) if is_likert else (lambda g, p: int(g) != int(p))
    make = _likert_card if is_likert else _binary_card
    raw_gold = [t[1] for t in triples]
    raw_pred = [t[2] for t in triples]
    adj: list[tuple[float, float]] = []
    n_disagree = n_audited_disagree = corrected = excluded = 0
    for rid, g, p in triples:
        dis = is_dis(g, p)
        cat = audit_map.get((rid, key))
        if dis:
            n_disagree += 1
            if cat:
                n_audited_disagree += 1
        if dis and cat == "human_label_incorrect":
            adj.append((p, p)); corrected += 1
        elif dis and cat in _ADJ_EXCLUDE:
            excluded += 1
        else:
            adj.append((g, p))

    raw_card = make(raw_gold, raw_pred)
    adj_card = make([a[0] for a in adj], [a[1] for a in adj]) if adj else None
    full = n_disagree > 0 and n_audited_disagree == n_disagree and (corrected or excluded) > 0

    card["ai_vs_human"] = raw_card
    card["ai_vs_human_adjudicated"] = adj_card
    card["audit"] = {
        "n_disagreements": n_disagree, "n_audited": n_audited_disagree,
        "corrected": corrected, "excluded": excluded, "full": full,
        "gate_basis": "adjudicated" if (full and adj_card) else "raw",
    }
    basis = adj_card if (full and adj_card) else raw_card
    card["gate"] = _gate(is_likert, basis, human["alpha"] if human["computable"] else None)
    return card


def _binary_card(gold: list[float], pred: list[float]) -> dict:
    g = [int(x) for x in gold]
    p = [int(x) for x in pred]
    s = MM.binary_scores(g, p)
    n_pos, n_neg = sum(g), len(g) - sum(g)
    judge_pass = (sum(p) / len(p)) if p else None
    gold_pass = (sum(g) / len(g)) if g else None
    bias = (judge_pass - gold_pass) if (judge_pass is not None and gold_pass is not None) else None
    lo, hi = MM.bootstrap_ci([float(x) for x in g], [float(x) for x in p],
                             lambda a, b: MM.binary_scores([int(v) for v in a], [int(v) for v in b])["balanced_accuracy"])
    return {
        "n": s["n"], "n_pos": n_pos, "n_neg": n_neg,
        "confusion": {"tp": s["tp"], "fp": s["fp"], "fn": s["fn"], "tn": s["tn"]},
        "accuracy": _round(s["accuracy"]), "precision": _round(s["precision"]),
        "recall": _round(s["recall"]), "specificity": _round(s["specificity"]),
        "f1": _round(s["f1"]), "balanced_accuracy": _round(s["balanced_accuracy"]),
        "mcc": _round(s["mcc"]), "cohen_kappa": _round(s["cohen_kappa"]),
        "balanced_accuracy_ci": [_round(lo), _round(hi)],
        "bias": _round(bias),
        "judge_pass_rate": _round(judge_pass), "human_pass_rate": _round(gold_pass),
        "calibration": MM.calibration_label(bias, "binary"),
        "single_class_judge": len(set(p)) <= 1,
        "single_class_gold": len(set(g)) <= 1,
    }


def _likert_card(gold: list[float], pred: list[float]) -> dict:
    err = MM.error_metrics(gold, pred)
    lo, hi = MM.bootstrap_ci(gold, pred, lambda a, b: MM.spearman(a, b))
    return {
        "n": len(gold),
        "mae": _round(err["mae"]), "rmse": _round(err["rmse"]), "bias": _round(err["bias"]),
        "spearman": _round(MM.spearman(gold, pred)), "spearman_ci": [_round(lo), _round(hi)],
        "qwk": _round(MM.quadratic_weighted_kappa(gold, pred)),
        "human_mean": _round(sum(gold) / len(gold) if gold else None),
        "judge_mean": _round(sum(pred) / len(pred) if pred else None),
        "calibration": MM.calibration_label(err["bias"], "likert"),
    }


def _gate(is_likert: bool, card: dict, human_alpha: float | None) -> dict:
    """Multi-signal readiness — sample size, human agreement, class balance, single-class
    behaviour, and agreement together. A judge is never called ready off one number, and a
    dimension whose humans don't agree is capped at 'review' (audit the rubric first)."""
    n = card.get("n") or 0
    warnings: list[str] = []
    if n < SMALL_SAMPLE:
        return {"verdict": "insufficient",
                "reason": f"Only {n} gold-labeled item(s) — need ≥{SMALL_SAMPLE} for a verdict.",
                "warnings": warnings}

    ambiguous = human_alpha is not None and human_alpha < 0.4
    if ambiguous:
        warnings.append(f"Reviewers barely agree on this dimension (α={human_alpha:.2f}); the gold "
                        "labels are ambiguous — audit them before trusting the judge.")

    if is_likert:
        rho, qwk, mae = card.get("spearman"), card.get("qwk"), card.get("mae")
        if rho is not None and qwk is not None and mae is not None:
            if rho >= 0.7 and qwk >= 0.6 and mae <= 0.5:
                base = "pass"
            elif rho >= 0.4 and qwk >= 0.4 and mae <= 1.0:
                base = "review"
            else:
                base = "fail"
        else:
            base = "review"
        reason = {"pass": "Strong ordinal agreement with the human panel.",
                  "review": "Moderate agreement — spot-check before trusting.",
                  "fail": "Weak agreement with human scores."}[base]
        if base == "pass" and ambiguous:
            base, reason = "review", "Agreement looks strong, but reviewers disagree on the rubric — audit first."
        return {"verdict": base, "reason": reason, "warnings": warnings}

    # Binary.
    if card.get("single_class_gold"):
        warnings.append("Humans labeled only one class — discrimination can't be measured; "
                        "add clear examples of the missing class.")
        return {"verdict": "insufficient",
                "reason": "Only one human class present — can't assess pass/fail discrimination.",
                "warnings": warnings}
    if card.get("n_neg", 0) == 0:
        warnings.append("No human 'fail' examples — failure detection is unmeasured.")
    if card.get("single_class_judge"):
        only = "pass" if (card.get("judge_pass_rate") or 0) >= 0.5 else "fail"
        warnings.append(f"Judge predicts '{only}' for every item — accuracy/F1 may be inflated by "
                        "class imbalance; check specificity and failure detection.")

    kappa = card.get("cohen_kappa")
    bacc = card.get("balanced_accuracy")
    spec = card.get("specificity")
    if kappa is not None and bacc is not None:
        if kappa >= 0.6 and bacc >= 0.8 and (spec is None or spec >= 0.5):
            base = "pass"
        elif kappa >= 0.4 and bacc >= 0.65:
            base = "review"
        else:
            base = "fail"
    else:
        base = "review"
    reason = {"pass": "Strong, class-balanced agreement with the human panel.",
              "review": "Moderate agreement — spot-check before trusting.",
              "fail": "Weak agreement once class balance is accounted for."}[base]

    # Cap at 'review' when the rubric itself is shaky or the judge only ever predicts one class.
    if base == "pass" and (ambiguous or card.get("single_class_judge")):
        base = "review"
        reason = ("Metrics look strong, but " +
                  ("reviewers disagree on the rubric" if ambiguous else "the judge never predicts the other class") +
                  " — validate before trusting.")
    return {"verdict": base, "reason": reason, "warnings": warnings}


def _alpha_ci(matrix: list[list[float]], level: str) -> list[float | None]:
    def stat(idx_a, _idx_b):
        return MM.krippendorff_alpha([matrix[int(i)] for i in idx_a], level)

    n = len(matrix)
    if n < 3:
        return [None, None]
    lo, hi = MM.bootstrap_ci(list(range(n)), list(range(n)), stat, n_boot=400)
    return [lo, hi]


def _value(judgment, is_likert: bool) -> float | None:
    """Numeric value of a judgment on the active scale (binary 1/0, or Likert 1–5)."""
    if is_likert:
        if judgment.score is not None:
            return float(judgment.score)
        if judgment.verdict is not None:  # a categorical judge on a Likert project → map to poles
            return 5.0 if judgment.verdict.value == "pass" else 1.0
        return None
    if judgment.verdict is not None:
        return 1.0 if judgment.verdict.value == "pass" else 0.0
    if judgment.score is not None:  # a Likert score on a binary project → threshold at midpoint
        return 1.0 if judgment.score >= 3 else 0.0
    return None


def _round(x: float | None, ndigits: int = 3) -> float | None:
    return None if x is None else round(x, ndigits)
