"""Auth route: identity from Databricks Apps SSO (no passwords).

The frontend calls GET /auth/whoami on load; we resolve the signed-in Databricks user from the
forwarded identity headers. Role is derived from project membership: a user invited only as a
reviewer is a scoped reviewer (TESTER, restricted to their project(s)); anyone else with app
access is a facilitator. App access itself is governed by Databricks app permissions.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import UserRole, get_db
from server.schemas import LoginResponse, ProjectRef, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/whoami", response_model=LoginResponse)
def whoami(request: Request, db: Session = Depends(get_db)):
    ident = A.resolve_identity(request)
    if ident is None:
        raise HTTPException(
            status_code=401,
            detail="Couldn't identify you. Open the app through Databricks (SSO), "
                   "or set DEV_FACILITATOR_EMAIL for local development.",
        )
    user = A.get_or_create_user(db, ident["email"], ident.get("name"))
    role = A.resolve_role(db, user.id)
    if user.role != role:  # keep the stored role in sync with membership (for display)
        user.role = role
        db.commit()
    projects = ([ProjectRef(id=p.id, name=p.name) for p in A.member_projects(db, user.id)]
                if role == UserRole.TESTER else [])
    return LoginResponse(user=UserOut.model_validate(user, from_attributes=True),
                         token=user.id, projects=projects)
