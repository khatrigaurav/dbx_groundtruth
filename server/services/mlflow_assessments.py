"""MLflow trace maintenance.

Judge/human verdicts are logged to MLflow via the Evaluation Run (see mlflow_eval) — one atomic
`mlflow.genai.evaluate()` pass that creates and scores traces together. We deliberately do NOT
log assessments onto traces by hand: `log_feedback` right after creating a trace raced MLflow's
async trace export and failed with NOT_FOUND, and it added latency to the review buttons.

What remains here is best-effort cleanup: dropping a replaced dataset's traces so the experiment
doesn't accumulate stale rows.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def purge_traces(experiment_id: str, trace_ids: list[str]) -> None:
    """Best-effort delete of specific traces (used when a dataset is replaced). Runs off-thread;
    never raises."""
    ids = [t for t in (trace_ids or []) if t]
    if not experiment_id or not ids:
        return
    try:
        import mlflow

        mlflow.set_tracking_uri("databricks")
        for i in range(0, len(ids), 100):  # API caps trace_ids per call
            try:
                mlflow.delete_traces(experiment_id=experiment_id, trace_ids=ids[i:i + 100])
            except Exception as e:  # noqa: BLE001
                logger.warning("purge_traces chunk failed: %s", e)
                break
    except Exception as e:  # noqa: BLE001
        logger.warning("purge_traces skipped for experiment %s: %s", experiment_id, e)
