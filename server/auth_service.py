"""Identity-based auth (Databricks Apps SSO).

No passwords, no committed credentials. Every request to a Databricks App carries the
signed-in user's identity in forwarded headers (`X-Forwarded-Email` etc.), injected by the
Databricks reverse proxy — so we trust them *only* on-platform. Who can reach the app at all
is governed by the app's Databricks permissions; anyone who reaches it is a facilitator.

- Facilitator: any signed-in Databricks user.
- Tester/reviewer: still recorded as a project member (soft attribution of "who reviewed
  what" against their real SSO email) — no longer a separate access gate.

Local dev has no proxy, so `X-Forwarded-*` is absent and NEVER trusted from the client;
set `DEV_FACILITATOR_EMAIL` to stand in for the signed-in identity.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy.orm import Session

from server.database import Project, ProjectMember, User, UserRole

logger = logging.getLogger(__name__)


def resolve_identity(request) -> dict | None:
    """Return {email, name} of the signed-in Databricks user, or None if unidentified.

    On Databricks Apps the reverse proxy sets these headers on every authenticated request;
    they are trustworthy only because the proxy injects them. Off-platform (local dev) they
    are absent and any client-supplied value is ignored — we fall back to DEV_FACILITATOR_EMAIL.
    """
    # Header casing is normalized by Starlette; these are the documented Apps headers.
    email = request.headers.get("x-forwarded-email")
    name = request.headers.get("x-forwarded-preferred-username")
    if not email:
        dev = os.getenv("DEV_FACILITATOR_EMAIL")
        if dev:
            logger.info("No forwarded identity; using DEV_FACILITATOR_EMAIL=%s (local dev)", dev)
            return {"email": dev.lower(), "name": name or dev}
        return None
    return {"email": email.lower(), "name": name or email}


def get_or_create_user(db: Session, email: str, name: str | None, role: UserRole = UserRole.TESTER) -> User:
    user = db.query(User).filter(User.email == email.lower()).first()
    if user is None:
        user = User(email=email.lower(), name=name, role=role)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def resolve_role(db: Session, user_id: str) -> UserRole:
    """Role is derived from project membership, not a stored flag:
      - invited to a project only as a reviewer (TESTER) → scoped reviewer;
      - a facilitator member of any project, OR never invited at all (a signed-in Databricks
        user with app access) → facilitator (full access).
    """
    members = db.query(ProjectMember).filter(ProjectMember.user_id == user_id).all()
    if not members:
        return UserRole.FACILITATOR
    if any(m.role == UserRole.FACILITATOR for m in members):
        return UserRole.FACILITATOR
    return UserRole.TESTER


def member_projects(db: Session, user_id: str) -> list[Project]:
    """Projects this user is a member of (used to scope a reviewer to their assignments)."""
    return (
        db.query(Project)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .filter(ProjectMember.user_id == user_id)
        .order_by(Project.created_at.desc())
        .all()
    )


def is_project_member(db: Session, project_id: str, user_id: str) -> bool:
    return (
        db.query(ProjectMember)
        .filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
        .first()
        is not None
    )


def ensure_membership(db: Session, project_id: str, user_id: str, role: UserRole) -> None:
    if not is_project_member(db, project_id, user_id):
        db.add(ProjectMember(project_id=project_id, user_id=user_id, role=role))
        db.commit()


def get_project_or_none(db: Session, project_id: str) -> Project | None:
    return db.query(Project).filter(Project.id == project_id).first()
