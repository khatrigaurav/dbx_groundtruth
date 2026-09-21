"""Auth route: identity from Databricks Apps SSO (no passwords).

The frontend calls GET /auth/whoami on load; we resolve the signed-in Databricks user from
the forwarded identity headers and return their user record (creating it on first sight).
Everyone who can reach the app is a facilitator — app access is governed by Databricks
app permissions, not by this endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import UserRole, get_db
from server.schemas import LoginResponse, UserOut

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
    user = A.get_or_create_user(db, ident["email"], ident.get("name"), UserRole.FACILITATOR)
    return LoginResponse(user=UserOut.model_validate(user, from_attributes=True), token=user.id)
