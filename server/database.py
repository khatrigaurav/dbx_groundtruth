"""SQLAlchemy ORM models, engine/session wiring, and schema bootstrap.

Core model (deliberately flat — no phases/discovery/IRR like VibeScaler):
    User ─< ProjectMember >─ Project ─< Item ─< Response ─< Judgment
    Item.expected_answer is the "answer key"; Judgment.kind ∈ {llm, human}.
"""

from __future__ import annotations

import datetime as _dt
import enum
import logging
import os
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker
from sqlalchemy.types import JSON

from server.db_config import (
    DatabaseBackend,
    create_engine_for_backend,
    detect_database_backend,
    get_schema_name,
)

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


# --- enums -------------------------------------------------------------------
class UserRole(str, enum.Enum):
    FACILITATOR = "facilitator"
    TESTER = "tester"


class ItemSource(str, enum.Enum):
    CSV = "csv"
    GENIE = "genie"
    MLFLOW = "mlflow"
    MANUAL = "manual"


class JudgmentKind(str, enum.Enum):
    LLM = "llm"
    HUMAN = "human"


class Verdict(str, enum.Enum):
    PASS = "pass"
    FAIL = "fail"


class ProjectScale(str, enum.Enum):
    """How reviewers/judges score each response. Chosen at project creation, then locked."""
    BINARY = "binary"   # pass / fail
    LIKERT = "likert"   # 1–5


class GenerationMode(str, enum.Enum):
    """How answers are generated from Genie for a project's questions."""
    USER = "user"  # OBO / foreground — appears in the user's Genie One history
    SP = "sp"      # background jobs/runs/submit as the app service principal


# --- tables ------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"
    id = Column(String(32), primary_key=True, default=_uuid)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    role = Column(Enum(UserRole, native_enum=False), nullable=False, default=UserRole.TESTER)
    password_hash = Column(String(255), nullable=True)  # facilitators only
    created_at = Column(DateTime(timezone=True), default=_now)


class Project(Base):
    __tablename__ = "projects"
    id = Column(String(32), primary_key=True, default=_uuid)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    created_by = Column(String(32), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    # Scoring scale — chosen at creation, then locked (see ProjectScale).
    scale = Column(Enum(ProjectScale, native_enum=False), nullable=False, default=ProjectScale.BINARY)
    # The project's own MLflow experiment (auto-created on first generation, deleted on project delete).
    mlflow_experiment_id = Column(String(255), nullable=True)
    # Last Genie generation mode used, for display (user | sp).
    genie_last_run_mode = Column(Enum(GenerationMode, native_enum=False), nullable=True)
    # Custom LLM-judge config (nullable → falls back to service defaults).
    judge_instructions = Column(Text, nullable=True)
    judge_model = Column(String(255), nullable=True)
    # Blind review: when true, human reviewers don't see the expected answer while judging.
    blind_review = Column(Boolean, nullable=False, default=False)
    # Persisted AI Results summary — survives reloads and is shared across users. Regenerated on
    # demand; summary_note is set only for the computed (non-LLM) fallback. summary_at is an ISO
    # timestamp string (stored as text to keep the additive ALTER portable across SQLite/Postgres).
    summary = Column(Text, nullable=True)
    summary_note = Column(Text, nullable=True)
    summary_model = Column(String(255), nullable=True)
    summary_at = Column(String(40), nullable=True)

    items = relationship("Item", back_populates="project", cascade="all, delete-orphan")
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    judges = relationship("ProjectJudge", back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_member"),)
    id = Column(String(32), primary_key=True, default=_uuid)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False, index=True)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False, index=True)
    role = Column(Enum(UserRole, native_enum=False), nullable=False, default=UserRole.TESTER)

    project = relationship("Project", back_populates="members")


class ProjectJudge(Base):
    """Which MLflow judges are enabled for a project (multi-select).

    `judge_key` is a built-in key (correctness, guidelines, relevance, groundedness,
    safety) or "custom". Optional per-judge overrides for instructions/model.
    """
    __tablename__ = "project_judges"
    __table_args__ = (UniqueConstraint("project_id", "judge_key", name="uq_project_judge"),)
    id = Column(String(32), primary_key=True, default=_uuid)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False, index=True)
    judge_key = Column(String(64), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    instructions = Column(Text, nullable=True)  # for custom / guidelines
    model = Column(String(255), nullable=True)

    project = relationship("Project", back_populates="judges")


class GenerationRun(Base):
    """DB-backed status of a background generation run, so progress survives across gunicorn
    workers (in-memory state is per-process). One row per project (upserted each run)."""
    __tablename__ = "generation_runs"
    project_id = Column(String(32), primary_key=True)
    status = Column(String(20), nullable=False, default="running")  # running | done | error | cancelled
    mode = Column(String(20), nullable=True)  # user | sp
    total = Column(Integer, nullable=False, default=0)
    generated = Column(Integer, nullable=False, default=0)
    # Pipeline phase (generate → grade run one after another in a single background worker).
    phase = Column(String(20), nullable=True)  # generating | grading
    graded = Column(Integer, nullable=False, default=0)
    grade_total = Column(Integer, nullable=False, default=0)
    detail = Column(Text, nullable=True)
    errors = Column(Text, nullable=True)  # JSON-encoded list
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)


class Item(Base):
    __tablename__ = "items"
    id = Column(String(32), primary_key=True, default=_uuid)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False, index=True)
    question = Column(Text, nullable=False)
    expected_answer = Column(Text, nullable=True)  # the answer key (optional)
    source = Column(Enum(ItemSource, native_enum=False), nullable=False, default=ItemSource.MANUAL)
    mlflow_trace_id = Column(String(255), nullable=True)
    item_metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    project = relationship("Project", back_populates="items")
    responses = relationship("Response", back_populates="item", cascade="all, delete-orphan")


class Response(Base):
    __tablename__ = "responses"
    id = Column(String(32), primary_key=True, default=_uuid)
    item_id = Column(String(32), ForeignKey("items.id"), nullable=False, index=True)
    response_text = Column(Text, nullable=False)
    model_name = Column(String(255), nullable=True)
    mlflow_trace_id = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    item = relationship("Item", back_populates="responses")
    judgments = relationship("Judgment", back_populates="response", cascade="all, delete-orphan")


class Judgment(Base):
    __tablename__ = "judgments"
    id = Column(String(32), primary_key=True, default=_uuid)
    response_id = Column(String(32), ForeignKey("responses.id"), nullable=False, index=True)
    kind = Column(Enum(JudgmentKind, native_enum=False), nullable=False)
    rater_id = Column(String(32), ForeignKey("users.id"), nullable=True)  # null for llm
    # The evaluation *dimension* this verdict is about — always an AI-judge key
    # (correctness/relevance/safety/groundedness/guidelines/custom) or the legacy "overall".
    # For llm judgments this is the judge that produced the row; for human judgments it is the
    # dimension the reviewer scored (1-1 with the enabled AI judges). Legacy human rows are null
    # and fold into the project's primary dimension for metrics.
    judge_key = Column(String(64), nullable=True)
    verdict = Column(Enum(Verdict, native_enum=False), nullable=True)  # binary scale
    score = Column(Float, nullable=True)  # likert scale (1–5), also normalized fallback
    rationale = Column(Text, nullable=True)
    # Id of the MLflow assessment mirroring this verdict onto the response's trace, so re-grades
    # / re-reviews replace it instead of piling up duplicate assessments. Best-effort, may be null.
    mlflow_assessment_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    response = relationship("Response", back_populates="judgments")


class DisagreementCategory(str, enum.Enum):
    """How a reviewer classifies an AI-judge-vs-human disagreement during the gold-label audit."""
    AI_INCORRECT = "ai_incorrect"
    HUMAN_LABEL_INCORRECT = "human_label_incorrect"
    AMBIGUOUS_QUESTION = "ambiguous_question"
    AMBIGUOUS_RUBRIC = "ambiguous_rubric"
    DIFFERENT_INTERPRETATION = "different_interpretation"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    OTHER = "other"


class DisagreementReview(Base):
    """Gold-label audit: a reviewer's classification of a single (response, dimension)
    disagreement between an AI judge and the human panel. One row per (response, judge_key):
    upserted so re-auditing replaces the prior verdict rather than piling up."""
    __tablename__ = "disagreement_reviews"
    __table_args__ = (UniqueConstraint("response_id", "judge_key", name="uq_disagreement_dim"),)
    id = Column(String(32), primary_key=True, default=_uuid)
    response_id = Column(String(32), ForeignKey("responses.id"), nullable=False, index=True)
    judge_key = Column(String(64), nullable=False)  # the dimension the disagreement is on
    category = Column(Enum(DisagreementCategory, native_enum=False), nullable=False)
    note = Column(Text, nullable=True)
    reviewer_id = Column(String(32), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)


# --- engine / session --------------------------------------------------------
_engine = None
SessionLocal: sessionmaker | None = None


def get_engine():
    global _engine, SessionLocal
    if _engine is None:
        _engine = create_engine_for_backend(detect_database_backend())
        SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def bootstrap_database() -> None:
    """Create the schema (Postgres) and all tables. Idempotent.

    Phase-0 uses metadata.create_all; Alembic migrations arrive in Phase 1.
    """
    engine = get_engine()
    is_pg = detect_database_backend() == DatabaseBackend.POSTGRESQL
    # Log the resolved backend loudly so it's never ambiguous which store the app is using
    # (silent SQLite in prod is a data-loss trap — see the guard in db_config).
    if is_pg:
        logger.info("DB backend: Lakebase Postgres — host=%s db=%s schema=%s",
                    os.getenv("PGHOST"), os.getenv("PGDATABASE"), get_schema_name())
    else:
        logger.info("DB backend: SQLite (local file) — NOT Lakebase")
    if is_pg:
        from sqlalchemy import text

        schema = get_schema_name()
        with engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
        logger.info("Ensured schema %s exists", schema)
    Base.metadata.create_all(bind=engine)
    _ensure_columns(engine, is_pg)
    logger.info("bootstrap_database: tables ensured")


# Lightweight additive migrations for columns added after a table already exists
# (create_all never ALTERs existing tables). Postgres supports IF NOT EXISTS; for
# SQLite we tolerate the "duplicate column" error.
_ADDITIVE_COLUMNS = [
    ("projects", "judge_instructions", "TEXT"),
    ("projects", "judge_model", "VARCHAR(255)"),
    # Enum columns store the member NAME (uppercase), matching SQLAlchemy's Enum default.
    ("projects", "scale", "VARCHAR(20) DEFAULT 'BINARY'"),
    ("projects", "mlflow_experiment_id", "VARCHAR(255)"),
    ("projects", "genie_last_run_mode", "VARCHAR(20)"),
    ("projects", "blind_review", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("projects", "summary", "TEXT"),
    ("projects", "summary_note", "TEXT"),
    ("projects", "summary_model", "VARCHAR(255)"),
    ("projects", "summary_at", "VARCHAR(40)"),
    ("judgments", "judge_key", "VARCHAR(64)"),
    ("judgments", "mlflow_assessment_id", "VARCHAR(64)"),
    ("generation_runs", "phase", "VARCHAR(20)"),
    ("generation_runs", "graded", "INTEGER NOT NULL DEFAULT 0"),
    ("generation_runs", "grade_total", "INTEGER NOT NULL DEFAULT 0"),
]


def _ensure_columns(engine, is_pg: bool) -> None:
    from sqlalchemy import text

    for table, col, coltype in _ADDITIVE_COLUMNS:
        stmt = (
            f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {coltype}'
            if is_pg else f'ALTER TABLE {table} ADD COLUMN {col} {coltype}'
        )
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
        except Exception as e:  # noqa: BLE001 — SQLite duplicate-column is expected/idempotent
            if "duplicate column" not in str(e).lower():
                logger.debug("ensure_columns %s.%s: %s", table, col, e)


def get_db():
    """FastAPI dependency: yields a session and always closes it."""
    if SessionLocal is None:
        get_engine()
    assert SessionLocal is not None
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
