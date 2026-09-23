"""Human review: submit / update per-dimension pass-fail (or Likert) judgments on a response.

Each human verdict is keyed by an evaluation *dimension* (Judgment.judge_key), 1-1 with the
project's enabled AI judges — so "AI correctness" is scored against "human correctness", not a
single generic pass/fail. The batch endpoint saves every dimension for a response in one call
with a shared comment.

The disagreement-audit endpoints back the gold-label audit workflow on the Results page.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from server.database import (
    DisagreementCategory,
    DisagreementReview,
    Judgment,
    JudgmentKind,
    Response,
    get_db,
)
from server.schemas import (
    DisagreementReviewCreate,
    DisagreementReviewOut,
    JudgmentBatchCreate,
    JudgmentCreate,
    JudgmentOut,
)

router = APIRouter(prefix="/responses", tags=["review"])


def _upsert_human(db: Session, response_id: str, *, rater_id: str | None, judge_key: str | None,
                  verdict=None, score=None, rationale=None) -> Judgment:
    """Upsert one human judgment for (response, rater, dimension)."""
    q = (
        db.query(Judgment)
        .filter(
            Judgment.response_id == response_id,
            Judgment.kind == JudgmentKind.HUMAN,
            Judgment.rater_id == rater_id,
        )
    )
    # Match the dimension exactly (null matches null for the legacy single-verdict path).
    q = q.filter(Judgment.judge_key.is_(None)) if judge_key is None else q.filter(Judgment.judge_key == judge_key)
    existing = q.first()
    if existing:
        existing.verdict = verdict
        existing.score = score
        if rationale is not None:
            existing.rationale = rationale
        return existing
    j = Judgment(response_id=response_id, kind=JudgmentKind.HUMAN, rater_id=rater_id,
                 judge_key=judge_key, verdict=verdict, score=score, rationale=rationale)
    db.add(j)
    return j


@router.post("/{response_id}/judgment", response_model=JudgmentOut)
def submit_human_judgment(response_id: str, body: JudgmentCreate, db: Session = Depends(get_db)):
    if db.query(Response).filter(Response.id == response_id).first() is None:
        raise HTTPException(status_code=404, detail="Response not found")
    j = _upsert_human(db, response_id, rater_id=body.rater_id, judge_key=body.judge_key,
                      verdict=body.verdict, score=body.score, rationale=body.rationale)
    db.commit()
    db.refresh(j)
    return JudgmentOut.model_validate(j, from_attributes=True)


@router.post("/{response_id}/judgments", response_model=list[JudgmentOut])
def submit_human_judgments(response_id: str, body: JudgmentBatchCreate, db: Session = Depends(get_db)):
    """Save a reviewer's verdicts across every dimension for one response, with a shared comment."""
    if db.query(Response).filter(Response.id == response_id).first() is None:
        raise HTTPException(status_code=404, detail="Response not found")
    out: list[Judgment] = []
    for d in body.dims:
        out.append(_upsert_human(db, response_id, rater_id=body.rater_id, judge_key=d.judge_key,
                                 verdict=d.verdict, score=d.score, rationale=body.rationale))
    db.commit()
    for j in out:
        db.refresh(j)
    return [JudgmentOut.model_validate(j, from_attributes=True) for j in out]


# --- gold-label audit (disagreement classification) --------------------------
@router.post("/{response_id}/disagreement", response_model=DisagreementReviewOut)
def classify_disagreement(response_id: str, body: DisagreementReviewCreate,
                          x_user_id: str | None = Header(default=None),
                          db: Session = Depends(get_db)):
    if db.query(Response).filter(Response.id == response_id).first() is None:
        raise HTTPException(status_code=404, detail="Response not found")
    try:
        category = DisagreementCategory(body.category)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"Unknown category {body.category!r}") from e
    row = (
        db.query(DisagreementReview)
        .filter(DisagreementReview.response_id == response_id,
                DisagreementReview.judge_key == body.judge_key)
        .first()
    )
    if row:
        row.category = category
        row.note = body.note
        row.reviewer_id = body.reviewer_id or x_user_id
    else:
        row = DisagreementReview(response_id=response_id, judge_key=body.judge_key,
                                 category=category, note=body.note,
                                 reviewer_id=body.reviewer_id or x_user_id)
        db.add(row)
    db.commit()
    return DisagreementReviewOut(response_id=response_id, judge_key=body.judge_key,
                                 category=category.value, note=row.note, reviewer_id=row.reviewer_id)
