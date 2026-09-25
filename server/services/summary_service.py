"""LLM-written narrative summary of a project's Results.

Feeds the computed metrics (plus a few concrete disagreement examples) to a serving endpoint
and asks for a short, plain-English read for a facilitator: can these judges be trusted, where
are the risks/biases, is there enough data, and what to do next. Uses the same OpenAI-compatible
Databricks serving client as generation (genie_service._synthesize).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from server.config import chat_content_text, get_oauth_token, get_workspace_host
from server.database import Item, JudgmentKind, Project
from server.services import metrics_service as METRICS

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are an eval analyst helping a facilitator interpret the results of validating LLM "
    "judges against a human review panel. Each judge is validated against the human panel for the "
    "SAME dimension (AI correctness vs human correctness, AI safety vs human safety, etc.) — never "
    "against a generic overall verdict. For each dimension the data gives, in order: (a) whether "
    "reviewers agree on the rubric (inter-reviewer α), (b) whether the AI agrees with the panel "
    "(class-balanced metrics), (c) the judge's calibration (lenient/harsh), and (d) a readiness "
    "gate. Write for a technical but time-poor reader.\n\n"
    "Return GitHub-flavored Markdown, ~160-230 words, in this shape:\n"
    "1. **Bottom line** — one sentence per-dimension trust verdict where it differs.\n"
    "2. **Per-dimension read** — a short bullet per dimension: reviewer agreement FIRST (call out "
    "low/ambiguous rubrics), then AI-vs-panel numbers (balanced accuracy/MCC/κ or Spearman/QWK), "
    "and the gate.\n"
    "3. **Watch-outs** — calibration bias, single-class judges (all-pass/all-fail), class "
    "imbalance, thin samples. When reviewer agreement is low, do NOT blame the judge — flag the "
    "rubric. Never present high accuracy under heavy imbalance as strong.\n"
    "4. **Next step** — one concrete recommendation.\n\n"
    "Ground every claim in the numbers provided. Never invent metrics. If a dimension has no human "
    "reviews yet, say it can't be validated until humans grade a sample."
)

_MAX_EXAMPLES = 6


def _default_model() -> str:
    return os.environ.get("SERVING_ENDPOINT", "databricks-claude-sonnet-5")


def _disagreement_examples(db: Session, project_id: str, dimension: str | None) -> list[dict]:
    """A few items where the AI judge and the human panel disagree ON THE PRIMARY DIMENSION —
    the most useful evidence for a human read. Best-effort; empty if nothing qualifies."""
    if not dimension:
        return []
    items = db.query(Item).filter(Item.project_id == project_id).all()
    out: list[dict] = []
    for it in items:
        for r in it.responses:
            # Human verdicts for this dimension (legacy null-dimension rows count toward primary).
            humans = [1 if j.verdict and j.verdict.value == "pass" else 0
                      for j in r.judgments
                      if j.kind == JudgmentKind.HUMAN and j.verdict is not None
                      and (j.judge_key == dimension or j.judge_key is None)]
            judge = next((j for j in r.judgments
                          if j.kind == JudgmentKind.LLM and j.judge_key == dimension
                          and j.verdict is not None), None)
            if not humans or judge is None:
                continue
            human_pass = sum(humans) * 2 >= len(humans)
            judge_pass = judge.verdict.value == "pass"
            if human_pass != judge_pass:
                out.append({
                    "dimension": dimension,
                    "question": it.question[:200],
                    "expected_answer": (it.expected_answer or "")[:200],
                    "response": (r.response_text or "")[:200],
                    "judge_verdict": judge.verdict.value,
                    "human_verdict": "pass" if human_pass else "fail",
                    "judge_rationale": (judge.rationale or "")[:200],
                })
            if len(out) >= _MAX_EXAMPLES:
                return out
    return out


_GATE_WORD = {"pass": "trusted", "review": "spot-check only", "fail": "NOT ready",
              "insufficient": "needs more data"}


def _fallback_summary(project_name: str, metrics: dict) -> str:
    """A deterministic, no-LLM read of the metrics, used when the serving model is unavailable so
    the panel always shows something useful. Mirrors the LLM prompt's structure."""
    dims = metrics.get("dimensions") or []
    if not dims:
        return ("_No dimensions to summarize yet._ Configure AI judges and have reviewers grade a "
                "sample, then regenerate.")
    def _f(x):
        return "n/a" if x is None else x

    lines = [f"**Bottom line.** Per-dimension verdicts for **{project_name}**:"]
    watch: list[str] = []
    worst = "pass"
    order = {"pass": 0, "review": 1, "insufficient": 2, "fail": 3}
    for d in dims:
        g = (d.get("gate") or {}).get("verdict", "insufficient")
        if order.get(g, 2) > order.get(worst, 0):
            worst = g
    lines.append("")
    lines.append("**Per-dimension read.**")
    for d in dims:
        h = d.get("human") or {}
        a = d.get("ai_vs_human") or {}
        g = d.get("gate") or {}
        agree = (f"reviewer agreement {h.get('level')} (α {_f(h.get('alpha'))})"
                 if h.get("computable") else "single reviewer — panel agreement not measurable")
        if a and "balanced_accuracy" in a:
            nums = (f"balanced acc {_f(a.get('balanced_accuracy'))}, MCC {_f(a.get('mcc'))}, "
                    f"κ {_f(a.get('cohen_kappa'))}, specificity {_f(a.get('specificity'))}")
        elif a:
            nums = f"Spearman ρ {_f(a.get('spearman'))}, QWK {_f(a.get('qwk'))}, MAE {_f(a.get('mae'))}"
        else:
            nums = "no AI-vs-human overlap yet"
        lines.append(f"- **{d.get('label')}** — {agree}; {nums} → **{_GATE_WORD.get(g.get('verdict'), g.get('verdict'))}**. {g.get('reason', '')}")
        for w in (g.get("warnings") or []):
            watch.append(f"{d.get('label')}: {w}")
    if watch:
        lines.append("")
        lines.append("**Watch-outs.**")
        lines += [f"- {w}" for w in watch]
    lines.append("")
    nxt = {
        "fail": "At least one judge isn't ready — inspect its disagreements below, tighten the judge's rubric, and re-grade (or fix ambiguous gold labels).",
        "insufficient": "Collect more human-reviewed items (aim for ≥15 per dimension, with both pass and fail examples), then regenerate.",
        "review": "Usable with human spot-checks — audit the disagreements below before trusting any judge unattended.",
        "pass": "Judges look trustworthy; keep periodic spot-checks.",
    }[worst]
    lines.append(f"**Next step.** {nxt}")
    return "\n".join(lines)


def summarize_results(db: Session, project_id: str, model: str | None = None) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}

    metrics = METRICS.project_metrics(db, project_id)
    primary = metrics.get("primary_dimension")
    examples = _disagreement_examples(db, project_id, primary)

    dims = metrics.get("dimensions") or []
    primary_card = next((d for d in dims if d.get("key") == primary), None)
    payload = {
        "project_name": project.name,
        "scale": metrics.get("scale"),
        "counts": {
            "items": metrics.get("n_items"),
            "responses": metrics.get("n_responses"),
            "reviewers": metrics.get("n_reviewers"),
            "dimensions": metrics.get("n_dimensions"),
            "answer_key_coverage": metrics.get("answer_key_coverage"),
            "panel_agreement_computable": metrics.get("panel_agreement_computable"),
        },
        "primary_dimension": primary,
        "dimensions": dims,
        "disagreement_examples": examples,
    }

    n_gold = primary_card.get("n_gold") if primary_card else 0
    small_sample = primary_card.get("small_sample") if primary_card else True

    model = (model or project.judge_model or _default_model()).strip()
    try:
        from openai import OpenAI

        client = OpenAI(api_key=get_oauth_token(),
                        base_url=f"{get_workspace_host()}/serving-endpoints", max_retries=3)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": "Summarize these eval results:\n\n"
                 + json.dumps(payload, ensure_ascii=False)},
            ],
            max_tokens=650,
        )
        text = chat_content_text(resp.choices[0].message.content).strip()
        if not text:
            raise ValueError("the model returned an empty response")
        at = _persist(db, project, text, model, None)
        return {"summary": text, "model": model, "at": at, "n_gold": n_gold, "small_sample": small_sample}
    except Exception as e:  # noqa: BLE001
        # Never leave the panel blank: fall back to a computed, no-LLM read of the same numbers.
        logger.warning("results summary LLM generation failed (%s); using computed fallback", e)
        fb, note = _fallback_summary(project.name, metrics), f"LLM summary unavailable ({e}); showing a computed read."
        at = _persist(db, project, fb, "computed (no LLM)", note)
        return {"summary": fb, "model": "computed (no LLM)", "fallback": True, "note": note,
                "at": at, "n_gold": n_gold, "small_sample": small_sample}


def _persist(db: Session, project: Project, text: str, model: str, note: str | None) -> str | None:
    """Save the generated summary onto the project row (Lakebase/SQLite) so it survives reloads
    and is shared across users. Best-effort — a persistence failure never blocks returning the text."""
    at = datetime.now(timezone.utc).isoformat()
    project.summary, project.summary_note, project.summary_model, project.summary_at = text, note, model, at
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("persisting results summary failed (%s); returning it unsaved", e)
        return None
    return at


def saved_summary(db: Session, project_id: str) -> dict:
    """The last-saved Results summary for a project (or {"summary": None} if none yet)."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if p is None:
        return {"detail": "Project not found."}
    if not p.summary:
        return {"summary": None}
    return {"summary": p.summary, "model": p.summary_model, "note": p.summary_note,
            "fallback": bool(p.summary_note), "at": p.summary_at}
