"""Read items (with their responses + judgments) for a project."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from server.database import Item, get_db
from server.schemas import ItemOut, JudgmentOut, ResponseOut

router = APIRouter(prefix="/projects", tags=["items"])


def item_to_out(item: Item) -> ItemOut:
    return ItemOut(
        id=item.id,
        question=item.question,
        expected_answer=item.expected_answer,
        source=item.source,
        responses=[
            ResponseOut(
                id=r.id,
                response_text=r.response_text,
                model_name=r.model_name,
                mlflow_trace_id=r.mlflow_trace_id,
                judgments=[JudgmentOut.model_validate(j, from_attributes=True) for j in r.judgments],  # includes judge_key/score
            )
            for r in item.responses
        ],
    )


@router.get("/{project_id}/items", response_model=list[ItemOut])
def list_items(project_id: str, db: Session = Depends(get_db)):
    items = (
        db.query(Item)
        .filter(Item.project_id == project_id)
        .order_by(Item.created_at.asc())
        .all()
    )
    return [item_to_out(i) for i in items]
