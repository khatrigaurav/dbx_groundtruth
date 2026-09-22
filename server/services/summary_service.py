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

from sqlalchemy.orm import Session

from server.config import get_oauth_token, get_workspace_host
from server.database import Item, JudgmentKind, Project
from server.services import metrics_service as METRICS

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are an eval analyst helping a facilitator interpret the results of validating LLM "
    "judges against a human review panel. The human panel is the ground truth; when an answer "
    "key exists, correctness is graded against it. Write for a technical but time-poor reader.\n\n"
    "Return GitHub-flavored Markdown, ~150-220 words, in this shape:\n"
    "1. **Bottom line** — one sentence: can the judge(s) be trusted to run without a human, "
    "trusted with spot-checks, or not yet?\n"
    "2. **Per-judge read** — a short bullet per judge citing its key numbers (F1/κ or "
    "Spearman/QWK) and its trust gate.\n"
    "3. **Watch-outs** — bias (lenient/harsh), low agreement, or thin data. Be explicit when the "
    "sample is too small to conclude.\n"
    "4. **Next step** — one concrete recommendation.\n\n"
    "Ground every claim in the numbers provided. Never invent metrics. If there are no human "
    "reviews yet, say the judges can't be validated until humans grade a sample."
)

_MAX_EXAMPLES = 6


def _default_model() -> str:
    return os.environ.get("SERVING_ENDPOINT", "databricks-claude-sonnet-5")


def _disagreement_examples(db: Session, project_id: str, primary_judge: str | None) -> list[dict]:
    """A few items where the primary judge and the human panel disagree — the most useful
    evidence for a human read. Best-effort; empty if nothing qualifies."""
    if not primary_judge:
        return []
    items = db.query(Item).filter(Item.project_id == project_id).all()
    out: list[dict] = []
    for it in items:
        for r in it.responses:
            humans = [1 if j.verdict and j.verdict.value == "pass" else 0
                      for j in r.judgments
                      if j.kind == JudgmentKind.HUMAN and j.verdict is not None]
            judge = next((j for j in r.judgments
                          if j.kind == JudgmentKind.LLM and j.judge_key == primary_judge
                          and j.verdict is not None), None)
            if not humans or judge is None:
                continue
            human_pass = sum(humans) * 2 >= len(humans)
            judge_pass = judge.verdict.value == "pass"
            if human_pass != judge_pass:
                out.append({
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


def summarize_results(db: Session, project_id: str, model: str | None = None) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}

    metrics = METRICS.project_metrics(db, project_id)
    examples = _disagreement_examples(db, project_id, metrics.get("primary_judge"))

    payload = {
        "project_name": project.name,
        "scale": metrics.get("scale"),
        "counts": {
            "items": metrics.get("n_items"),
            "responses": metrics.get("n_responses"),
            "gold_labeled": metrics.get("n_gold"),
            "reviewers": metrics.get("n_reviewers"),
            "judges": metrics.get("n_judges"),
            "answer_key_coverage": metrics.get("answer_key_coverage"),
            "small_sample": metrics.get("small_sample"),
        },
        "agreement": {
            "alpha_all": metrics.get("alpha_all"),
            "alpha_humans": metrics.get("alpha_humans"),
            "human_pass_rate": metrics.get("human_pass_rate"),
            "human_mean": metrics.get("human_mean"),
        },
        "judges": metrics.get("judges"),
        "disagreement_examples": examples,
    }

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
        text = resp.choices[0].message.content or ""
    except Exception as e:  # noqa: BLE001
        logger.warning("results summary generation failed: %s", e)
        return {"detail": f"Couldn't generate a summary: {e}", "model": model}

    return {"summary": text, "model": model,
            "n_gold": metrics.get("n_gold"), "small_sample": metrics.get("small_sample")}
