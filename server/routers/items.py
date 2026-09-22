"""Read items (with their responses + judgments) for a project."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import Item, UserRole, get_db
from server.schemas import ItemOut, JudgmentOut, ResponseOut

router = APIRouter(prefix="/projects", tags=["items"])


def item_to_out(item: Item, *, include_expected: bool = True) -> ItemOut:
    return ItemOut(
        id=item.id,
        question=item.question,
        # Blind review strips the answer key here so it never reaches the client —
        # a UI-only hide still shipped it in the payload (visible via the network tab).
        expected_answer=item.expected_answer if include_expected else None,
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
def list_items(
    project_id: str,
    x_user_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    project = A.get_project_or_none(db, project_id)
    items = (
        db.query(Item)
        .filter(Item.project_id == project_id)
        .order_by(Item.created_at.asc())
        .all()
    )
    # When blind review is on, only a confirmed facilitator receives the expected answer.
    # Fail closed: if we can't positively identify the caller as a facilitator, blind it.
    include_expected = True
    if project is not None and project.blind_review:
        is_facilitator = bool(x_user_id) and A.resolve_role(db, x_user_id) == UserRole.FACILITATOR
        include_expected = is_facilitator
    return [item_to_out(i, include_expected=include_expected) for i in items]
