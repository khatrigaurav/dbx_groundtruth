"""Auth routes: facilitator (password) and tester (email + project) login."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import UserRole, get_db
from server.schemas import LoginRequest, LoginResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    # 1) Facilitator path (password in auth.yaml)
    fac = A.authenticate_facilitator(body.email, body.password)
    if fac:
        user = A.get_or_create_user(db, fac["email"], fac.get("name"), UserRole.FACILITATOR)
        return LoginResponse(user=UserOut.model_validate(user, from_attributes=True), token=user.id)

    # A password was supplied but didn't match a facilitator.
    if body.password:
        raise HTTPException(status_code=401, detail="Invalid facilitator credentials")

    # 2) Tester path — email + a project they belong to.
    if not body.project_id:
        raise HTTPException(status_code=400, detail="Testers must select a project to join")
    project = A.get_project_or_none(db, body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    user = A.get_or_create_user(db, body.email, None, UserRole.TESTER)
    if not A.is_project_member(db, body.project_id, user.id):
        raise HTTPException(status_code=403, detail="You have not been invited to this project")
    return LoginResponse(user=UserOut.model_validate(user, from_attributes=True), token=user.id)
