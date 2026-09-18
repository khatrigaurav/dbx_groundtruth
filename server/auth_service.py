"""Lightweight, stateless auth (mirrors VibeScaler's model, simplified).

- Facilitators are preconfigured in config/auth.yaml (email + SHA-256 password).
- Testers self-serve by email; they must be a member of the project they select.
- "Token" in v1 is just the user id — the frontend stores it and sends it back.
"""

from __future__ import annotations

import hashlib
import logging
import os
from functools import lru_cache

import yaml
from sqlalchemy.orm import Session

from server.database import Project, ProjectMember, User, UserRole

logger = logging.getLogger(__name__)

_AUTH_YAML = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "auth.yaml")


@lru_cache(maxsize=1)
def _facilitators() -> dict[str, dict]:
    try:
        with open(_AUTH_YAML) as f:
            data = yaml.safe_load(f) or {}
        return {f["email"].lower(): f for f in data.get("facilitators", [])}
    except FileNotFoundError:
        logger.warning("auth.yaml not found at %s — no preconfigured facilitators", _AUTH_YAML)
        return {}


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def authenticate_facilitator(email: str, password: str | None) -> dict | None:
    fac = _facilitators().get(email.lower())
    if not fac or not password:
        return None
    if _sha256(password) == fac.get("password_sha256"):
        return fac
    return None


def get_or_create_user(db: Session, email: str, name: str | None, role: UserRole) -> User:
    user = db.query(User).filter(User.email == email.lower()).first()
    if user is None:
        user = User(email=email.lower(), name=name, role=role)
        db.add(user)
        db.commit()
        db.refresh(user)
    elif role == UserRole.FACILITATOR and user.role != UserRole.FACILITATOR:
        user.role = UserRole.FACILITATOR
        db.commit()
    return user


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
