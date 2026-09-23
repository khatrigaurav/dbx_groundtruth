"""MLflow experiment lifecycle — one experiment per project.

Created lazily on first generation (so projects with no generated answers cost nothing),
deleted when the project is deleted. All calls are best-effort against `databricks` tracking
and never raise into the request path — a missing experiment must not block CRUD.
"""

from __future__ import annotations

import logging
import os

from server.config import get_workspace_host

logger = logging.getLogger(__name__)

# Workspace folder under which per-project experiments live. /Shared is reliably writable
# by the app service principal (SPs have no /Users home). Override via env if desired.
_BASE = os.environ.get("MLFLOW_EXPERIMENT_BASE", "/Shared/groundtruth")


def _mlflow():
    import mlflow

    mlflow.set_tracking_uri("databricks")
    return mlflow


def experiment_url(experiment_id: str | None) -> str | None:
    if not experiment_id:
        return None
    host = get_workspace_host().rstrip("/")
    return f"{host}/ml/experiments/{experiment_id}"


def genie_url() -> str | None:
    """Link to the workspace Genie One landing (where OBO conversations show up)."""
    host = get_workspace_host().rstrip("/")
    if not host:
        return None
    return os.environ.get("GENIE_ONE_URL", f"{host}/genie")


def _experiment_name(project) -> str:
    # Slug the project name for readability; keep the id for uniqueness.
    slug = "".join(c if c.isalnum() or c in "-_ " else "-" for c in (project.name or "")).strip()[:48]
    return f"{_BASE}/{slug or 'project'}-{project.id[:8]}"


def _ensure_base_dir() -> None:
    """Ensure the workspace folder that holds per-project experiments exists. MLflow's
    create_experiment does not create intermediate folders, so a fresh workspace fails with
    'Parent directory does not exist' without this. mkdirs is idempotent."""
    from server.config import get_workspace_client

    get_workspace_client().workspace.mkdirs(_BASE)


def ensure_experiment(db, project) -> str | None:
    """Return the project's experiment id, creating it on first use. Best-effort."""
    if project.mlflow_experiment_id:
        return project.mlflow_experiment_id
    try:
        mlflow = _mlflow()
        name = _experiment_name(project)
        # get_experiment_by_name avoids a duplicate-name error on retries.
        existing = mlflow.get_experiment_by_name(name)
        if existing:
            exp_id = existing.experiment_id
        else:
            _ensure_base_dir()  # create_experiment won't make intermediate workspace folders
            exp_id = mlflow.create_experiment(name)
        project.mlflow_experiment_id = str(exp_id)
        db.commit()
        logger.info("Created MLflow experiment %s for project %s", exp_id, project.id)
        return project.mlflow_experiment_id
    except Exception as e:  # noqa: BLE001
        logger.warning("ensure_experiment failed for project %s: %s", project.id, e)
        return None


def delete_experiment(experiment_id: str | None) -> bool:
    """Delete an experiment. Returns True if a delete was issued. Best-effort."""
    if not experiment_id:
        return False
    try:
        _mlflow().delete_experiment(experiment_id)
        logger.info("Deleted MLflow experiment %s", experiment_id)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("delete_experiment %s failed: %s", experiment_id, e)
        return False
