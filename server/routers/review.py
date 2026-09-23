"""Human review: submit / update a pass-fail judgment on a response."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.database import Judgment, JudgmentKind, Response, get_db
from server.schemas import JudgmentCreate, JudgmentOut

router = APIRouter(prefix="/responses", tags=["review"])


@router.post("/{response_id}/judgment", response_model=JudgmentOut)
def submit_human_judgment(response_id: str, body: JudgmentCreate, db: Session = Depends(get_db)):
    resp = db.query(Response).filter(Response.id == response_id).first()
    if resp is None:
        raise HTTPException(status_code=404, detail="Response not found")

    # One human judgment per (response, rater): upsert.
    existing = (
        db.query(Judgment)
        .filter(
            Judgment.response_id == response_id,
            Judgment.kind == JudgmentKind.HUMAN,
            Judgment.rater_id == body.rater_id,
        )
        .first()
    )
    if existing:
        existing.verdict = body.verdict
        existing.score = body.score
        existing.rationale = body.rationale
        db.commit()
        db.refresh(existing)
        _mirror_to_mlflow(db, existing)
        return JudgmentOut.model_validate(existing, from_attributes=True)

    j = Judgment(
        response_id=response_id,
        kind=JudgmentKind.HUMAN,
        rater_id=body.rater_id,
        verdict=body.verdict,
        score=body.score,
        rationale=body.rationale,
    )
    db.add(j)
    db.commit()
    db.refresh(j)
    _mirror_to_mlflow(db, j)
    return JudgmentOut.model_validate(j, from_attributes=True)


def _mirror_to_mlflow(db: Session, judgment: Judgment) -> None:
    """Best-effort: log the human verdict as an assessment on the response's MLflow trace."""
    from server.services.mlflow_assessments import log_judgment

    log_judgment(db, judgment)
