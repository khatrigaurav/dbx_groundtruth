"""Pydantic request/response schemas for the API."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel

from server.database import (
    GenerationMode,
    ItemSource,
    JudgmentKind,
    ProjectScale,
    UserRole,
    Verdict,
)


# --- auth --------------------------------------------------------------------
class UserOut(BaseModel):
    id: str
    email: str
    name: Optional[str] = None
    role: UserRole


class ProjectRef(BaseModel):
    id: str
    name: str


class LoginResponse(BaseModel):
    user: UserOut
    token: str  # v1: opaque = user id; frontend stores it
    # For a scoped reviewer, the project(s) they've been invited to review (empty for facilitators).
    projects: list[ProjectRef] = []


# --- projects ----------------------------------------------------------------
class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    scale: ProjectScale  # required — admin picks Binary or Likert at creation (no default)
    blind_review: bool = False


class BlindReviewUpdate(BaseModel):
    enabled: bool


class ProjectJudgeOut(BaseModel):
    judge_key: str
    enabled: bool = True
    instructions: Optional[str] = None
    model: Optional[str] = None


class ProjectOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    item_count: int = 0
    scale: ProjectScale = ProjectScale.BINARY
    mlflow_experiment_id: Optional[str] = None
    experiment_url: Optional[str] = None
    genie_url: Optional[str] = None
    genie_last_run_mode: Optional[GenerationMode] = None
    judges: list[ProjectJudgeOut] = []
    judge_instructions: Optional[str] = None
    judge_model: Optional[str] = None
    blind_review: bool = False


class JudgeConfig(BaseModel):
    """Update the enabled judge set (+ optional custom instructions/model)."""
    judges: list[ProjectJudgeOut] = []
    # Back-compat: a single custom-judge instruction/model still accepted.
    judge_instructions: Optional[str] = None
    judge_model: Optional[str] = None


class JudgeCatalogItem(BaseModel):
    key: str
    label: str
    description: str
    uses_answer_key: bool
    needs_context: bool = False
    is_custom: bool = False


class MemberInvite(BaseModel):
    email: str
    name: Optional[str] = None


# --- items / responses / judgments ------------------------------------------
class JudgmentOut(BaseModel):
    id: str
    kind: JudgmentKind
    rater_id: Optional[str] = None
    judge_key: Optional[str] = None
    verdict: Optional[Verdict] = None
    score: Optional[float] = None
    rationale: Optional[str] = None


class ResponseOut(BaseModel):
    id: str
    response_text: str
    model_name: Optional[str] = None
    mlflow_trace_id: Optional[str] = None
    judgments: list[JudgmentOut] = []


class ItemOut(BaseModel):
    id: str
    question: str
    expected_answer: Optional[str] = None
    source: ItemSource
    responses: list[ResponseOut] = []


class JudgmentCreate(BaseModel):
    verdict: Optional[Verdict] = None   # binary scale
    score: Optional[float] = None       # likert scale (1–5)
    rationale: Optional[str] = None
    rater_id: Optional[str] = None


class IntakeResult(BaseModel):
    items_created: int
    responses_created: int
    warnings: list[str] = []
    detail: Optional[str] = None


class GenieQuestion(BaseModel):
    question: str
    expected_answer: Optional[str] = None


class GenieIntakeRequest(BaseModel):
    questions: list[GenieQuestion]


class MlflowIntakeRequest(BaseModel):
    experiment_id: str
    max_traces: int = 50
    filter_string: Optional[str] = None


# --- generation --------------------------------------------------------------
class GenerateRequest(BaseModel):
    """Generate answers for the project's questions via Genie One MCP."""
    mode: GenerationMode  # user (OBO, foreground) | sp (background job)
    # If item_ids omitted, generate for every question without a response yet.
    item_ids: Optional[list[str]] = None


class GenerateResult(BaseModel):
    mode: GenerationMode
    generated: int = 0
    run_id: Optional[str] = None          # job run id for sp/background mode
    run_url: Optional[str] = None
    genie_url: Optional[str] = None
    experiment_id: Optional[str] = None
    experiment_url: Optional[str] = None
    surfaces_in_genie_ui: bool = False
    errors: list[str] = []
    detail: Optional[str] = None
