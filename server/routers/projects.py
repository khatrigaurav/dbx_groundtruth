"""Project CRUD + tester invitations."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import (
    DisagreementReview,
    Item,
    Project,
    ProjectJudge,
    ProjectMember,
    Response,
    User,
    UserRole,
    get_db,
)
from server.schemas import (
    BlindReviewUpdate,
    JudgeConfig,
    MemberInvite,
    ProjectCreate,
    ProjectJudgeOut,
    ProjectOut,
    UserOut,
)
from server.services import experiment_service as EXP
from server.services import metrics_service as METRICS

router = APIRouter(prefix="/projects", tags=["projects"])


def _project_out(db: Session, p: Project) -> ProjectOut:
    count = db.query(Item).filter(Item.project_id == p.id).count()
    judges = [
        ProjectJudgeOut(judge_key=j.judge_key, enabled=j.enabled,
                        instructions=j.instructions, model=j.model)
        for j in db.query(ProjectJudge).filter(ProjectJudge.project_id == p.id).all()
    ]
    return ProjectOut(
        id=p.id, name=p.name, description=p.description, item_count=count,
        scale=p.scale,
        mlflow_experiment_id=p.mlflow_experiment_id,
        experiment_url=EXP.experiment_url(p.mlflow_experiment_id),
        genie_url=EXP.genie_url() if p.mlflow_experiment_id else None,
        genie_last_run_mode=p.genie_last_run_mode,
        judges=judges,
        judge_instructions=p.judge_instructions, judge_model=p.judge_model,
        blind_review=p.blind_review,
    )


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)):
    return [_project_out(db, p) for p in db.query(Project).order_by(Project.created_at.desc()).all()]


@router.post("", response_model=ProjectOut)
def create_project(
    body: ProjectCreate,
    x_user_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    project = Project(name=body.name, description=body.description,
                      scale=body.scale, created_by=x_user_id, blind_review=body.blind_review)
    db.add(project)
    db.commit()
    db.refresh(project)
    # Creator becomes a facilitator member.
    if x_user_id:
        A.ensure_membership(db, project.id, x_user_id, UserRole.FACILITATOR)
    return _project_out(db, project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db)):
    p = A.get_project_or_none(db, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_out(db, p)


@router.put("/{project_id}/judge-config", response_model=ProjectOut)
def set_judge_config(project_id: str, body: JudgeConfig, db: Session = Depends(get_db)):
    p = A.get_project_or_none(db, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    # Back-compat single-judge fields.
    p.judge_instructions = (body.judge_instructions or "").strip() or None
    p.judge_model = (body.judge_model or "").strip() or None
    # Replace the enabled-judge set.
    db.query(ProjectJudge).filter(ProjectJudge.project_id == project_id).delete()
    for j in body.judges:
        db.add(ProjectJudge(
            project_id=project_id, judge_key=j.judge_key, enabled=j.enabled,
            instructions=(j.instructions or "").strip() or None,
            model=(j.model or "").strip() or None,
        ))
    db.commit()
    return _project_out(db, p)


@router.put("/{project_id}/blind-review", response_model=ProjectOut)
def set_blind_review(project_id: str, body: BlindReviewUpdate, db: Session = Depends(get_db)):
    """Facilitator toggle: when enabled, human reviewers don't see the expected answer."""
    p = A.get_project_or_none(db, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    p.blind_review = body.enabled
    db.commit()
    return _project_out(db, p)


@router.get("/{project_id}/metrics")
def project_metrics(project_id: str, db: Session = Depends(get_db)):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return METRICS.project_metrics(db, project_id)


@router.get("/{project_id}/disagreements")
def list_disagreements(project_id: str, db: Session = Depends(get_db)):
    """Saved gold-label audit classifications for this project's responses, keyed for the UI as
    `{response_id}:{judge_key}` so the Results diagnostics panel can show/resume them."""
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = (
        db.query(DisagreementReview)
        .join(Response, Response.id == DisagreementReview.response_id)
        .join(Item, Item.id == Response.item_id)
        .filter(Item.project_id == project_id)
        .all()
    )
    return {f"{r.response_id}:{r.judge_key}": {
        "category": r.category.value, "note": r.note, "reviewer_id": r.reviewer_id}
        for r in rows}


@router.get("/{project_id}/results-summary")
def get_results_summary(project_id: str, db: Session = Depends(get_db)):
    """The last-saved Results summary (persisted on generate), so it survives reloads."""
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from server.services import summary_service as SUMMARY

    return SUMMARY.saved_summary(db, project_id)


@router.post("/{project_id}/results-summary")
def results_summary(project_id: str, db: Session = Depends(get_db)):
    """LLM-written plain-English read of the Results (judge trustworthiness, biases, next step).
    Persists the result on the project so it survives reloads and is shared across users."""
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from server.services import summary_service as SUMMARY

    try:
        return SUMMARY.summarize_results(db, project_id)
    except Exception as e:  # noqa: BLE001 — surface a message instead of a 500 blank panel
        return {"detail": f"Couldn't build the summary: {e}"}


@router.post("/{project_id}/mlflow-eval")
def mlflow_eval(project_id: str, db: Session = Depends(get_db)):
    """Log an MLflow Evaluation Run from the stored judge verdicts (replay — no re-grading),
    so results appear in the experiment's Evaluations tab. Errors are surfaced to the caller."""
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from server.services import mlflow_eval as ME

    try:
        return ME.run_evaluation(db, project_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"MLflow evaluation failed: {e}") from e


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db)):
    p = A.get_project_or_none(db, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    exp_id = p.mlflow_experiment_id
    db.delete(p)  # cascades to items → responses → judgments, members, judges
    db.commit()
    exp_deleted = EXP.delete_experiment(exp_id)
    detail = "Project deleted."
    if exp_id:
        detail += (" Its MLflow experiment was deleted."
                   if exp_deleted else
                   " Note: its MLflow experiment could not be deleted automatically — remove it manually.")
    return {"deleted": project_id, "experiment_deleted": exp_deleted,
            "experiment_id": exp_id, "detail": detail}


@router.post("/{project_id}/members", response_model=UserOut)
def invite_member(project_id: str, body: MemberInvite, db: Session = Depends(get_db)):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    user = A.get_or_create_user(db, body.email, body.name, UserRole.TESTER)
    A.ensure_membership(db, project_id, user.id, UserRole.TESTER)
    return UserOut.model_validate(user, from_attributes=True)


@router.get("/{project_id}/members", response_model=list[UserOut])
def list_members(project_id: str, db: Session = Depends(get_db)):
    rows = (
        db.query(User)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .filter(ProjectMember.project_id == project_id)
        .all()
    )
    return [UserOut.model_validate(u, from_attributes=True) for u in rows]
