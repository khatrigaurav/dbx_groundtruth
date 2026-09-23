"""LLM correctness judge route."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import get_db
from server.services.judge_service import run_judge_for_project

router = APIRouter(prefix="/projects", tags=["judge"])


@router.post("/{project_id}/run-judge")
def run_judge(project_id: str, db: Session = Depends(get_db)):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        result = run_judge_for_project(db, project_id)
        # Best-effort: mirror the AI verdicts into MLflow as trace assessments.
        from server.services.mlflow_assessments import log_project_ai_judgments
        log_project_ai_judgments(db, project_id)
        return result
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Judge run failed: {e}") from e
