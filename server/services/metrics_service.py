"""Judge-quality + agreement metrics for the Results page.

Two layers of measurement:
  1. Inter-rater agreement across the whole panel (Krippendorff's α) — how consistent are all
     raters (LLM judges + humans) with each other. Handles n raters, missing data, and both
     nominal (binary) and ordinal (Likert) scales.
  2. Per-judge quality vs. ground truth — each LLM judge scored against the human panel, which
     is the operational ground truth (reviewers grade against the answer key; the correctness
     judge takes the answer key as `expected_response`). Binary judges get a confusion matrix +
     precision/recall/F1/MCC/balanced-accuracy/κ; Likert judges get QWK/Spearman/MAE/bias.
     Headline metrics carry a bootstrap 95% CI so small samples aren't over-trusted.

All statistics live in metrics_math (pure, unit-tested); this module only shapes DB rows.
"""

from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from server.database import Item, JudgmentKind, Project, ProjectScale
from server.services import metrics_math as MM

# Below this many co-rated / gold-labeled units, metrics are noisy — the UI shows a caveat.
SMALL_SAMPLE = 15


def _human_gold_binary(verdicts: list[int]) -> int | None:
    """Human majority verdict for a response (1=pass, 0=fail). Ties break to pass, matching
    the client's majority rule. None when no human graded it."""
    if not verdicts:
        return None
    passes = sum(verdicts)
    return 1 if passes * 2 >= len(verdicts) else 0


def _judge_label(judge_key: str) -> str:
    return f"AI · {judge_key}"


def project_metrics(db: Session, project_id: str) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}
    scale = project.scale
    is_likert = scale == ProjectScale.LIKERT
    level = "ordinal" if is_likert else "nominal"

    items = db.query(Item).filter(Item.project_id == project_id).all()

    # --- gather rater values per response unit ------------------------------
    units: list[dict[str, float]] = []            # rater -> value, for α
    per_rater_vals: dict[str, list[float]] = defaultdict(list)
    rater_labels: dict[str, str] = {}
    judge_keys: list[str] = []
    seen_judge = set()

    # Per response: gold (human) + each judge's prediction, kept aligned for scorecards.
    gold_binary: list[int] = []
    gold_score: list[float] = []
    key_backed: list[bool] = []                   # whether this gold unit has an answer key
    judge_pred_binary: dict[str, list[tuple[int, int]]] = defaultdict(list)   # (gold, pred)
    judge_pred_score: dict[str, list[tuple[float, float]]] = defaultdict(list)  # (gold, pred)

    n_responses = 0
    for it in items:
        has_key = bool(it.expected_answer)
        for r in it.responses:
            n_responses += 1
            row: dict[str, float] = {}
            human_verdicts: list[int] = []
            human_scores: list[float] = []
            judge_verdicts: dict[str, int] = {}
            judge_scores: dict[str, float] = {}

            for j in r.judgments:
                if j.kind == JudgmentKind.LLM:
                    key = j.judge_key or "judge"
                    if key not in seen_judge:
                        seen_judge.add(key)
                        judge_keys.append(key)
                    rater = f"llm:{key}"
                    rater_labels[rater] = _judge_label(key)
                    if is_likert:
                        val = j.score if j.score is not None else (
                            5.0 if (j.verdict and j.verdict.value == "pass") else
                            1.0 if j.verdict else None)
                        if val is not None:
                            judge_scores[key] = float(val)
                    else:
                        if j.verdict is not None:
                            judge_verdicts[key] = 1 if j.verdict.value == "pass" else 0
                    v = _value_for_alpha(j, is_likert)
                    if v is not None:
                        row[rater] = v
                        per_rater_vals[rater].append(v)
                else:
                    if not j.rater_id:
                        continue
                    rater = f"human:{j.rater_id}"
                    rater_labels[rater] = j.rater_id
                    if is_likert and j.score is not None:
                        human_scores.append(float(j.score))
                    elif not is_likert and j.verdict is not None:
                        human_verdicts.append(1 if j.verdict.value == "pass" else 0)
                    v = _value_for_alpha(j, is_likert)
                    if v is not None:
                        row[rater] = v
                        per_rater_vals[rater].append(v)

            if row:
                units.append(row)

            # Build gold + aligned judge predictions for this response.
            if is_likert and human_scores:
                g = sum(human_scores) / len(human_scores)
                gold_score.append(g)
                key_backed.append(has_key)
                for key, s in judge_scores.items():
                    judge_pred_score[key].append((g, s))
            elif not is_likert and human_verdicts:
                g = _human_gold_binary(human_verdicts)
                if g is not None:
                    gold_binary.append(g)
                    key_backed.append(has_key)
                    for key, p in judge_verdicts.items():
                        judge_pred_binary[key].append((g, p))

    # --- inter-rater agreement (α) ------------------------------------------
    def alpha_over(raters: set[str] | None) -> float | None:
        matrix = [[v for rr, v in row.items() if raters is None or rr in raters] for row in units]
        return MM.krippendorff_alpha(matrix, level)

    def alpha_ci(raters: set[str] | None) -> list[float | None]:
        matrix = [[v for rr, v in row.items() if raters is None or rr in raters] for row in units]

        def stat(idx_a, _idx_b):  # bootstrap resamples units; recompute α on the sample
            return MM.krippendorff_alpha([matrix[int(i)] for i in idx_a], level)

        n = len(matrix)
        if n < 3:
            return [None, None]
        # reuse bootstrap_ci by passing unit indices as the paired arrays
        lo, hi = MM.bootstrap_ci(list(range(n)), list(range(n)), stat, n_boot=400)
        return [lo, hi]

    human_raters = {r for r in per_rater_vals if r.startswith("human:")}
    n_units_multi = sum(1 for row in units if len(row) >= 2)

    per_rater = [
        {
            "rater": r, "label": rater_labels.get(r, r),
            "kind": "llm" if r.startswith("llm:") else "human",
            "n": len(vals),
            "mean": round(sum(vals) / len(vals), 3) if vals else None,
            "pass_rate": (round(sum(1 for v in vals if v >= 1) / len(vals), 3)
                          if vals and not is_likert else None),
        }
        for r, vals in sorted(per_rater_vals.items())
    ]

    # --- per-judge scorecards vs the human panel ----------------------------
    n_gold = len(gold_score) if is_likert else len(gold_binary)
    human_pass_rate = (sum(gold_binary) / len(gold_binary)) if (not is_likert and gold_binary) else None
    human_mean = (sum(gold_score) / len(gold_score)) if (is_likert and gold_score) else None

    judges = []
    for key in judge_keys:
        card: dict = {"judge_key": key, "label": _judge_label(key)}
        if is_likert:
            pairs = judge_pred_score.get(key, [])
            g = [p[0] for p in pairs]
            pr = [p[1] for p in pairs]
            card["n"] = len(pairs)
            err = MM.error_metrics(g, pr)
            card["mae"] = _round(err["mae"])
            card["rmse"] = _round(err["rmse"])
            card["bias"] = _round(err["bias"])
            card["spearman"] = _round(MM.spearman(g, pr))
            card["qwk"] = _round(MM.quadratic_weighted_kappa(g, pr))
            card["human_mean"] = _round(sum(g) / len(g) if g else None)
            card["judge_mean"] = _round(sum(pr) / len(pr) if pr else None)
            lo, hi = MM.bootstrap_ci(g, pr, lambda a, b: MM.spearman(a, b))
            card["spearman_ci"] = [_round(lo), _round(hi)]
            card["gate"] = MM.trust_gate("likert", card)
        else:
            pairs = judge_pred_binary.get(key, [])
            g = [p[0] for p in pairs]
            pr = [p[1] for p in pairs]
            s = MM.binary_scores(g, pr)
            card.update({
                "n": s["n"],
                "confusion": {"tp": s["tp"], "fp": s["fp"], "fn": s["fn"], "tn": s["tn"]},
                "accuracy": _round(s["accuracy"]), "precision": _round(s["precision"]),
                "recall": _round(s["recall"]), "specificity": _round(s["specificity"]),
                "f1": _round(s["f1"]), "balanced_accuracy": _round(s["balanced_accuracy"]),
                "mcc": _round(s["mcc"]), "cohen_kappa": _round(s["cohen_kappa"]),
            })
            judge_pass = (sum(pr) / len(pr)) if pr else None
            gold_pass = (sum(g) / len(g)) if g else None
            card["bias"] = _round(judge_pass - gold_pass) if (judge_pass is not None and gold_pass is not None) else None
            lo, hi = MM.bootstrap_ci([float(x) for x in g], [float(x) for x in pr],
                                     lambda a, b: MM.binary_scores([int(v) for v in a], [int(v) for v in b])["f1"])
            card["f1_ci"] = [_round(lo), _round(hi)]
            card["gate"] = MM.trust_gate("binary", card)
        judges.append(card)

    # Primary judge = correctness (the answer-key grader) if present, else the first judge.
    primary_judge = "correctness" if "correctness" in judge_keys else (judge_keys[0] if judge_keys else None)

    return {
        "scale": scale.value,
        "level": level,
        "n_items": len(items),
        "n_responses": n_responses,
        "n_gold": n_gold,
        "n_reviewers": len(human_raters),
        "n_judges": len(judge_keys),
        "answer_key_coverage": {
            "with_key": sum(1 for it in items if it.expected_answer),
            "total": len(items),
        },
        "n_units_multi_rated": n_units_multi,
        "small_sample": n_units_multi < SMALL_SAMPLE or n_gold < SMALL_SAMPLE,
        "alpha_all": alpha_over(None),
        "alpha_all_ci": alpha_ci(None),
        "alpha_humans": alpha_over(human_raters) if len(human_raters) >= 2 else None,
        "alpha_humans_ci": alpha_ci(human_raters) if len(human_raters) >= 2 else [None, None],
        "human_pass_rate": _round(human_pass_rate),
        "human_mean": _round(human_mean),
        "per_rater": per_rater,
        "judges": judges,
        "primary_judge": primary_judge,
    }


def _value_for_alpha(judgment, is_likert: bool) -> float | None:
    if is_likert:
        if judgment.score is not None:
            return float(judgment.score)
        if judgment.verdict is not None:  # judge gave categorical → map to poles
            return 5.0 if judgment.verdict.value == "pass" else 1.0
        return None
    if judgment.verdict is not None:
        return 1.0 if judgment.verdict.value == "pass" else 0.0
    return None


def _round(x: float | None, ndigits: int = 3) -> float | None:
    return None if x is None else round(x, ndigits)
