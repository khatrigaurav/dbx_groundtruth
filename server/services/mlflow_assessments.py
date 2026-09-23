"""Mirror judgments into the project's MLflow experiment as trace assessments (Option 1).

Each AI judge verdict and each human review verdict is logged as an MLflow **Feedback**
assessment on the response's trace, alongside the answer key (already logged as an
*expectation* during generation). Evaluators can then validate both the responses and the
LLM judges in the MLflow Traces UI / Databricks Review App, and add their own labels.

Everything here is BEST-EFFORT and must never break grading or review:
  * MLflow may be unreachable (local/SQLite dev) or the experiment may not exist yet.
  * The installed MLflow may lack an API — we guard and degrade to a no-op with a warning.
  * Responses ingested without a trace (CSV upload) get a lightweight trace created lazily,
    so their assessments have somewhere to live.

Re-grades / re-reviews are idempotent: each judgment stores the id of the assessment it
created, and we delete-then-re-log so verdicts are replaced, not duplicated.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from server.database import Item, Judgment, JudgmentKind, Project, ProjectScale, Response

logger = logging.getLogger(__name__)


def _mlflow():
    import mlflow

    mlflow.set_tracking_uri("databricks")
    return mlflow


def _ensure_trace(mlflow, experiment_id: str, response: Response, item: Item) -> str | None:
    """Return the response's trace id, creating a lightweight trace if it has none
    (e.g. CSV-uploaded answers). Sets it on the response; the caller commits."""
    if response.mlflow_trace_id:
        return response.mlflow_trace_id
    mlflow.set_experiment(experiment_id=experiment_id)
    with mlflow.start_span(name="response", span_type="AGENT") as span:
        span.set_inputs({"question": item.question})
        span.set_outputs({"answer": response.response_text})
    trace_id = mlflow.get_last_active_trace_id()
    if trace_id and item.expected_answer:
        try:
            mlflow.log_expectation(trace_id=trace_id, name="expected_answer", value=item.expected_answer)
        except Exception:  # noqa: BLE001
            pass
    if trace_id:
        response.mlflow_trace_id = trace_id
    return trace_id


def log_judgment(db: Session, judgment: Judgment) -> None:
    """Log/refresh one judgment as an assessment on its response's trace. Best-effort."""
    try:
        response = db.query(Response).filter(Response.id == judgment.response_id).first()
        if response is None:
            return
        item = db.query(Item).filter(Item.id == response.item_id).first()
        if item is None:
            return
        project = db.query(Project).filter(Project.id == item.project_id).first()
        if project is None:
            return
        # Create the experiment on demand if the project never generated (e.g. CSV-uploaded
        # answers), so assessments always have somewhere to land — not just for Genie runs.
        experiment_id = project.mlflow_experiment_id
        if not experiment_id:
            from server.services.experiment_service import ensure_experiment
            experiment_id = ensure_experiment(db, project)
        if not experiment_id:
            return  # MLflow unavailable or the experiment couldn't be created

        # Resolve the verdict value before touching MLflow.
        if project.scale == ProjectScale.LIKERT and judgment.score is not None:
            value: object = float(judgment.score)
        elif judgment.verdict is not None:
            value = judgment.verdict.value
        else:
            return  # nothing decided yet

        is_llm = judgment.kind == JudgmentKind.LLM
        name = (judgment.judge_key or "judge") if is_llm else "human_review"

        mlflow = _mlflow()
        trace_id = _ensure_trace(mlflow, experiment_id, response, item)
        if not trace_id:
            return

        from mlflow.entities import AssessmentSource, AssessmentSourceType

        source = AssessmentSource(
            source_type=AssessmentSourceType.LLM_JUDGE if is_llm else AssessmentSourceType.HUMAN,
            source_id=(judgment.judge_key or "judge") if is_llm else (judgment.rater_id or "reviewer"),
        )
        # Idempotent replace: drop the prior assessment for this judgment, if any.
        if judgment.mlflow_assessment_id:
            try:
                mlflow.delete_assessment(trace_id=trace_id, assessment_id=judgment.mlflow_assessment_id)
            except Exception:  # noqa: BLE001
                pass
        fb = mlflow.log_feedback(trace_id=trace_id, name=name, value=value,
                                 rationale=(judgment.rationale or None), source=source)
        aid = (getattr(fb, "assessment_id", None)
               or getattr(getattr(fb, "assessment", None), "assessment_id", None))
        if aid:
            judgment.mlflow_assessment_id = aid
        db.commit()
    except Exception as e:  # noqa: BLE001 — mirroring must never break grading/review
        logger.warning("MLflow assessment logging skipped for judgment %s: %s",
                       getattr(judgment, "id", "?"), e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def log_project_ai_judgments(db: Session, project_id: str) -> int:
    """Mirror every LLM judgment in a project to MLflow — called after a grading run.
    Best-effort; returns how many it attempted."""
    try:
        rows = (
            db.query(Judgment)
            .join(Response, Response.id == Judgment.response_id)
            .join(Item, Item.id == Response.item_id)
            .filter(Item.project_id == project_id, Judgment.kind == JudgmentKind.LLM)
            .all()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("MLflow assessment sync could not load judgments for %s: %s", project_id, e)
        return 0
    for j in rows:
        log_judgment(db, j)
    return len(rows)
