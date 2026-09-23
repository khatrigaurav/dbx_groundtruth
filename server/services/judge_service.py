"""MLflow-native judge grading.

Uses MLflow's built-in judges (`mlflow.genai.judges`) — `is_correct`, `is_context_relevant`,
`is_safe`, `is_grounded`, `meets_guidelines` — plus user-defined `make_judge` custom judges.
A project can enable **multiple** judges (ProjectJudge rows); each produces its own
`Judgment(kind="llm", judge_key=...)` row, so each judge reads as its own rater in Results.

Model resolution per judge: judge.model → project.judge_model → SERVING_ENDPOINT, formatted as
the MLflow model URI `databricks:/<endpoint>` (verified working against FE serving endpoints).
Built-in judges are categorical (yes/no) → mapped to pass/fail; on a Likert project the same
signal is recorded as 5.0 / 1.0 (humans carry the finer-grained Likert scale).
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from sqlalchemy.orm import Session

from server.database import (
    Item,
    Judgment,
    JudgmentKind,
    Project,
    ProjectJudge,
    ProjectScale,
    Response,
    Verdict,
)

logger = logging.getLogger(__name__)

DEFAULT_INSTRUCTIONS = (
    "The response is correct if it conveys the expected answer, even if worded differently, "
    "rounded reasonably, or with extra context. It is incorrect if it states a different value, "
    "contradicts the expected answer, or fails to answer."
)

# Serving endpoints offered as judge models in the UI (kept in sync with the client).
AVAILABLE_JUDGE_MODELS = [
    "databricks-claude-sonnet-5",
    "databricks-claude-opus-4-5",
    "databricks-gpt-5",
    "databricks-meta-llama-3-3-70b-instruct",
]

# Endpoints Databricks has retired — no longer offered, and any project still configured with one
# auto-heals to the default so its grading run doesn't hard-fail with a BAD_REQUEST.
_DEPRECATED_MODELS = {"databricks-gemini-2-5-flash"}

# The built-in + custom judge catalog surfaced to the UI.
JUDGE_CATALOG = [
    {"key": "correctness", "label": "Correctness", "is_custom": False, "needs_context": False,
     "uses_answer_key": True,
     "description": "Does the answer match the expected answer key? (primary for answer-key eval)"},
    {"key": "relevance", "label": "Relevance to query", "is_custom": False, "needs_context": False,
     "uses_answer_key": False,
     "description": "Does the response actually address the question asked? (quality, ignores answer key)"},
    {"key": "safety", "label": "Safety", "is_custom": False, "needs_context": False,
     "uses_answer_key": False,
     "description": "Is the response free of harmful or unsafe content? (quality, ignores answer key)"},
    {"key": "groundedness", "label": "Groundedness", "is_custom": False, "needs_context": True,
     "uses_answer_key": False,
     "description": "Is the response supported by the retrieved data/SQL context? (needs generated context)"},
    {"key": "guidelines", "label": "Custom guidelines", "is_custom": False, "needs_context": False,
     "uses_answer_key": False,
     "description": "Does the response follow a rubric you write in plain language? (quality)"},
    {"key": "custom", "label": "Custom judge", "is_custom": True, "needs_context": False,
     "uses_answer_key": True,
     "description": "Your own grading instructions; can reference the question, response, and answer key."},
]
_CATALOG_BY_KEY = {j["key"]: j for j in JUDGE_CATALOG}


def _default_model() -> str:
    return os.environ.get("SERVING_ENDPOINT", "databricks-claude-sonnet-5")


# Judge calls are I/O-bound (serving-endpoint round-trips), so we fan them out across a bounded
# pool — 20 in flight by default, tunable via GRADE_CONCURRENCY. Kept in step with generation.
_GRADE_CONCURRENCY = 20
_MAX_GRADE_CONCURRENCY = 25


def _grade_concurrency() -> int:
    try:
        n = int(os.environ.get("GRADE_CONCURRENCY", str(_GRADE_CONCURRENCY)))
    except ValueError:
        n = _GRADE_CONCURRENCY
    return max(1, min(_MAX_GRADE_CONCURRENCY, n))


def _model_uri(name: str | None) -> str:
    name = (name or _default_model()).strip()
    if name.split("/")[-1] in _DEPRECATED_MODELS:  # a saved-but-retired endpoint → fall back
        name = _default_model()
    return name if name.startswith(("databricks:/", "endpoints:/")) else f"databricks:/{name}"


def _rating_to_pass(feedback) -> bool | None:
    """Map an MLflow Feedback categorical value to pass(True)/fail(False)/unknown(None)."""
    val = getattr(feedback, "value", feedback)
    s = str(getattr(val, "value", val)).strip().lower()
    if s in ("yes", "pass", "true", "1"):
        return True
    if s in ("no", "fail", "false", "0"):
        return False
    return None


def _invoke_judge(judge_key: str, model_uri: str, *, question: str, response_text: str,
                  expected: str | None, context: str | None, instructions: str):
    """Run one built-in/custom judge. Returns an MLflow Feedback. Raises on error."""
    from mlflow.genai import judges as J

    if judge_key == "correctness":
        return J.is_correct(request=question, response=response_text,
                            expected_response=expected or "", model=model_uri)
    if judge_key == "relevance":
        return J.is_context_relevant(request=question, context=response_text, model=model_uri)
    if judge_key == "safety":
        return J.is_safe(content=response_text, model=model_uri)
    if judge_key == "groundedness":
        return J.is_grounded(request=question, response=response_text,
                            context=(context or expected or ""), model=model_uri)
    if judge_key == "guidelines":
        return J.meets_guidelines(guidelines=(instructions or DEFAULT_INSTRUCTIONS),
                                context={"request": question, "response": response_text},
                                model=model_uri)
    if judge_key == "custom":
        judge = J.make_judge(
            name="custom",
            instructions=(instructions or DEFAULT_INSTRUCTIONS)
            + "\n\nQuestion: {{ inputs }}\nResponse: {{ outputs }}\nExpected answer: {{ expectations }}"
            + "\nReturn a pass/fail judgement.",
            model=model_uri,
        )
        return judge(inputs=question, outputs=response_text,
                    expectations={"expected_answer": expected or ""})
    raise ValueError(f"unknown judge_key {judge_key!r}")


def _enabled_judges(db: Session, project: Project) -> list[ProjectJudge]:
    rows = [j for j in db.query(ProjectJudge).filter(ProjectJudge.project_id == project.id).all()
            if j.enabled and j.judge_key in _CATALOG_BY_KEY]
    if rows:
        return rows
    # Default: correctness only, carrying any legacy per-project custom instructions/model.
    return [ProjectJudge(project_id=project.id, judge_key="correctness", enabled=True,
                        instructions=project.judge_instructions, model=project.judge_model)]


def run_judge_for_project(db: Session, project_id: str) -> dict:
    """Inline entry point (kept for POST /run-judge). Delegates to the parallel grader."""
    return grade_project(db, project_id)


def grade_project(db: Session, project_id: str, *, progress_cb=None, cancel_check=None) -> dict:
    """Run every enabled judge over every response. LLM calls fan out across a bounded thread
    pool (I/O-bound); DB writes stay on THIS thread (SQLAlchemy sessions aren't thread-safe),
    upserting one Judgment per (response, judge) as each result lands.

    progress_cb(done, total) and cancel_check() -> bool are optional hooks the background
    pipeline uses to report progress and honor a cancel; both run on this (caller's) thread.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"judged": 0, "detail": "Project not found."}
    is_likert = project.scale == ProjectScale.LIKERT
    judges = _enabled_judges(db, project)

    items = db.query(Item).filter(Item.project_id == project_id).all()
    pairs = [(it, r) for it in items for r in it.responses if r.response_text]

    skipped = 0
    per_judge: dict[str, dict[str, int]] = {pj.judge_key: {"graded": 0, "no_answer_key": 0} for pj in judges}
    # Build immutable tasks up front — ORM objects must never cross into the pool threads.
    tasks: list[dict] = []
    for item, response in pairs:
        context = None
        if isinstance(item.item_metadata, dict):
            context = item.item_metadata.get("generated_sql") or item.item_metadata.get("context")
        for pj in judges:
            spec = _CATALOG_BY_KEY[pj.judge_key]
            if spec["uses_answer_key"] and not item.expected_answer:
                skipped += 1
                per_judge[pj.judge_key]["no_answer_key"] += 1
                continue  # correctness/custom need an answer key
            tasks.append({
                "response_id": response.id, "judge_key": pj.judge_key,
                "model_uri": _model_uri(pj.model or project.judge_model),
                "question": item.question, "response_text": response.response_text,
                "expected": item.expected_answer, "context": context,
                "instructions": pj.instructions or project.judge_instructions or DEFAULT_INSTRUCTIONS,
            })

    grade_total = len(tasks)
    if progress_cb:
        progress_cb(0, grade_total)
    if not pairs:
        return {"judged": 0, "detail": "Nothing to grade yet (no responses)."}

    def _run(task: dict):
        fb = _invoke_judge(task["judge_key"], task["model_uri"], question=task["question"],
                           response_text=task["response_text"], expected=task["expected"],
                           context=task["context"], instructions=task["instructions"])
        return task, fb

    judged = 0
    done = 0
    errors: list[str] = []
    pool = ThreadPoolExecutor(max_workers=_grade_concurrency())
    try:
        futures = [pool.submit(_run, t) for t in tasks]
        for fut in as_completed(futures):
            if cancel_check and cancel_check():
                pool.shutdown(wait=False, cancel_futures=True)
                break
            done += 1
            try:
                task, fb = fut.result()
            except Exception as e:  # noqa: BLE001
                errors.append(str(e)[:200])
                logger.warning("judge call failed: %s", e)
                if progress_cb:
                    progress_cb(done, grade_total)
                continue
            passed = _rating_to_pass(fb)
            if passed is None:
                skipped += 1
                if progress_cb:
                    progress_cb(done, grade_total)
                continue
            verdict = Verdict.PASS if passed else Verdict.FAIL
            score = (5.0 if passed else 1.0) if is_likert else None
            rationale = str(getattr(fb, "rationale", "") or "")[:1000]
            existing = (
                db.query(Judgment)
                .filter(Judgment.response_id == task["response_id"], Judgment.kind == JudgmentKind.LLM,
                        Judgment.judge_key == task["judge_key"])
                .first()
            )
            if existing:
                existing.verdict, existing.score, existing.rationale = verdict, score, rationale
            else:
                db.add(Judgment(response_id=task["response_id"], kind=JudgmentKind.LLM,
                                judge_key=task["judge_key"], verdict=verdict, score=score, rationale=rationale))
            per_judge[task["judge_key"]]["graded"] += 1
            judged += 1
            if done % 10 == 0:
                db.commit()  # periodic flush so progress is durable on long runs
            if progress_cb:
                progress_cb(done, grade_total)
    finally:
        pool.shutdown(wait=False)
    db.commit()

    detail = f"Ran {len(judges)} judge(s) → {judged} judgement(s)."
    # Call out judges that produced nothing because questions lack an answer key.
    notes = []
    for key, c in per_judge.items():
        if c["graded"] == 0 and c["no_answer_key"] > 0:
            notes.append(f"‘{key}’ needs an answer key — skipped {c['no_answer_key']} question(s) without one")
    if notes:
        detail += " " + "; ".join(notes) + "."
    if errors:
        detail += f" {len(errors)} failed."
    return {"judged": judged, "skipped": skipped, "judges": [j.judge_key for j in judges],
            "per_judge": per_judge, "detail": detail, "errors": errors[:5]}
