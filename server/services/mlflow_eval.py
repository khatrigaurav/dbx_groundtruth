"""Produce an MLflow Evaluation Run from ALREADY-computed judge verdicts (replay — no new
LLM calls), so results also show up in the experiment's Evaluations tab.

Rationale: our own engine grades once (writing the DB + trace assessments). Rather than
re-invoking the judges inside `mlflow.genai.evaluate()` (double cost, possible drift), we pass
custom "replay" scorers that simply return each response's stored verdict. One real judge pass
then feeds all three surfaces — the app's Results page, the Traces tab, and the Evaluations tab —
with identical numbers.

Best-effort where called from the pipeline; the on-demand endpoint surfaces errors so we can
confirm the API against the deployed MLflow version.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from server.config import get_workspace_host
from server.database import Item, JudgmentKind, Project, ProjectScale
from server.services import experiment_service as EXP

logger = logging.getLogger(__name__)


def _feedback(value, rationale):
    """Wrap a replayed verdict as an MLflow Feedback (value + rationale); fall back to the bare
    value if the entity isn't importable on this MLflow version."""
    try:
        from mlflow.entities import Feedback

        return Feedback(value=value, rationale=(rationale or None))
    except Exception:  # noqa: BLE001
        return value


def _make_replay_scorer(judge_key: str, lookup: dict):
    """A scorer that returns the stored verdict for the row's response — no model call."""
    from mlflow.genai.scorers import scorer

    def fn(inputs=None, **kwargs):
        rid = inputs.get("response_id") if isinstance(inputs, dict) else None
        entry = lookup.get(rid, {}).get(judge_key)
        if entry is None:
            return None
        value, rationale = entry
        return _feedback(value, rationale)

    fn.__name__ = judge_key
    try:
        return scorer(name=judge_key)(fn)
    except TypeError:  # older signature without a name kwarg
        return scorer(fn)


def run_evaluation(db: Session, project_id: str) -> dict:
    """Log an Evaluation Run by replaying the project's stored verdicts (no re-grading), so
    results show in the Evaluations tab. Uses static data (works whether or not a response has a
    trace) — scoring existing traces proved unreliable since not every response carries one."""
    db.expire_all()  # read committed verdicts fresh (same worker session as grading)
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}
    experiment_id = project.mlflow_experiment_id or EXP.ensure_experiment(db, project)
    if not experiment_id:
        return {"detail": "No MLflow experiment for this project yet."}

    is_likert = project.scale == ProjectScale.LIKERT
    items = db.query(Item).filter(Item.project_id == project_id).all()

    lookup: dict[str, dict[str, tuple]] = {}
    data: list[dict] = []
    for it in items:
        for r in it.responses:
            if not r.response_text:
                continue
            verdicts: dict[str, tuple] = {}
            for j in r.judgments:
                if j.kind != JudgmentKind.LLM:
                    continue
                if is_likert and j.score is not None:
                    value: object = float(j.score)
                elif j.verdict is not None:
                    value = j.verdict.value
                else:
                    continue
                verdicts[j.judge_key or "judge"] = (value, j.rationale or "")
            if not verdicts:
                continue
            lookup[r.id] = verdicts
            data.append({
                "inputs": {"question": it.question, "response_id": r.id},
                "outputs": r.response_text,
                "expectations": {"expected_response": it.expected_answer or ""},
            })

    if not data:
        return {"detail": "No AI-graded responses yet — grade first, then evaluate."}

    judge_keys = sorted({k for v in lookup.values() for k in v})
    scorers = [_make_replay_scorer(k, lookup) for k in judge_keys]

    import mlflow

    mlflow.set_tracking_uri("databricks")
    mlflow.set_experiment(experiment_id=experiment_id)
    result = mlflow.genai.evaluate(data=data, scorers=scorers)

    run_id = getattr(result, "run_id", None)
    host = get_workspace_host().rstrip("/")
    url = f"{host}/ml/experiments/{experiment_id}" + (f"/runs/{run_id}" if isinstance(run_id, str) else "")
    return {"detail": f"Logged an evaluation run over {len(data)} response(s) with "
                      f"{len(judge_keys)} judge(s).",
            "evaluations_url": url, "n": len(data), "judges": judge_keys}


def run_evaluation_safe(db: Session, project_id: str) -> None:
    """Best-effort wrapper for the pipeline — never raises into the run."""
    try:
        run_evaluation(db, project_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("MLflow evaluation run skipped for project %s: %s", project_id, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
