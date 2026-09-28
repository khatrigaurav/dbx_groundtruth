"""Read items (with their responses + judgments) for a project."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import Item, JudgmentKind, UserRole, get_db
from server.schemas import ItemOut, JudgmentOut, ResponseOut

router = APIRouter(prefix="/projects", tags=["items"])


def _judgment_out(j, my_uid: str | None) -> JudgmentOut:
    out = JudgmentOut.model_validate(j, from_attributes=True)  # includes judge_key/score
    # "Mine" is decided server-side against the resolved caller, so the client can re-hydrate a
    # reviewer's own verdicts without trusting a (possibly stale) client-held id.
    out.mine = j.kind == JudgmentKind.HUMAN and my_uid is not None and j.rater_id == my_uid
    return out


def item_to_out(item: Item, *, include_expected: bool = True, my_uid: str | None = None) -> ItemOut:
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
                judgments=[_judgment_out(j, my_uid) for j in r.judgments],
            )
            for r in item.responses
        ],
    )


@router.get("/{project_id}/items", response_model=list[ItemOut])
def list_items(
    project_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    project = A.get_project_or_none(db, project_id)
    # Resolve the caller from the forwarded SSO identity (the same source the save path uses),
    # never a client-supplied id — so "mine" and the blind-review gate can't be spoofed or drift.
    me = A.current_user(request, db)
    my_uid = me.id if me else None
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
        is_facilitator = my_uid is not None and A.resolve_role(db, my_uid) == UserRole.FACILITATOR
        include_expected = is_facilitator
    return [item_to_out(i, include_expected=include_expected, my_uid=my_uid) for i in items]
