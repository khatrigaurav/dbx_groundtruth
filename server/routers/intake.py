"""Data intake. v1: CSV answer-sheet upload. (MLflow + Genie added in Phase 3.)

CSV columns (case-insensitive; flexible aliases):
  question | request | input            -> Item.question   (required)
  expected_answer | expected | answer    -> Item.expected_answer (optional)
  response | response_preview | output   -> Response.response_text (optional)
  model | model_name                     -> Response.model_name (optional)
"""

from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

from server import auth_service as A
from server.database import Item, ItemSource, Response, get_db
from server.schemas import (
    GenerateRequest,
    GenerateResult,
    GenieIntakeRequest,
    IntakeResult,
    MlflowIntakeRequest,
)

router = APIRouter(prefix="/projects", tags=["intake"])

_Q_COLS = ("question", "request", "input", "request_preview")
_EXP_COLS = ("expected_answer", "expected", "answer", "ground_truth")
_RESP_COLS = ("response", "response_preview", "output")
_MODEL_COLS = ("model", "model_name")


def _clean(text: str | None) -> str:
    if not text:
        return ""
    text = text.strip()
    while len(text) > 1 and text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    return text.replace('""', '"').replace("\\n", "\n")


def _pick(row: dict, keys) -> str:
    lower = {k.lower().strip(): v for k, v in row.items() if k}
    for k in keys:
        if k in lower:
            return _clean(lower[k])
    return ""


@router.post("/{project_id}/intake/csv", response_model=IntakeResult)
async def upload_csv(project_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")

    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV appears to be empty")

    cols = {c.lower().strip() for c in reader.fieldnames}
    if not (cols & set(_Q_COLS)):
        raise HTTPException(
            status_code=400,
            detail=f"CSV must have a question column (one of {_Q_COLS}). Found: {sorted(cols)}",
        )

    items_created = responses_created = 0
    warnings: list[str] = []
    for n, row in enumerate(reader, start=1):
        question = _pick(row, _Q_COLS)
        if not question:
            warnings.append(f"Row {n}: empty question, skipped")
            continue
        item = Item(
            project_id=project_id,
            question=question,
            expected_answer=_pick(row, _EXP_COLS) or None,
            source=ItemSource.CSV,
            item_metadata={"csv_row": n, "filename": file.filename},
        )
        db.add(item)
        db.flush()  # get item.id
        items_created += 1

        response_text = _pick(row, _RESP_COLS)
        if response_text:
            db.add(
                Response(
                    item_id=item.id,
                    response_text=response_text,
                    model_name=_pick(row, _MODEL_COLS) or None,
                )
            )
            responses_created += 1

    db.commit()
    if items_created == 0:
        raise HTTPException(status_code=400, detail="No valid rows found in CSV")
    return IntakeResult(
        items_created=items_created,
        responses_created=responses_created,
        warnings=warnings[:10],
        detail=f"Imported {items_created} items ({responses_created} with responses)",
    )


@router.post("/{project_id}/generate", response_model=GenerateResult)
def generate_answers(
    project_id: str,
    body: GenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_forwarded_access_token: str | None = Header(default=None),
):
    """Generate answers for the project's questions via Genie One MCP.

    mode=user → run on-behalf-of the signed-in user (foreground, shows in their Genie One).
    mode=sp   → background jobs/runs/submit as the app service principal (not in Genie One).
    """
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from server.services.generation_service import generate

    user_token = x_forwarded_access_token or request.headers.get("x-forwarded-access-token")
    try:
        return generate(db, project_id, body.mode, item_ids=body.item_ids, user_token=user_token)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}") from e


@router.get("/{project_id}/generate/status")
def generate_status(project_id: str, db: Session = Depends(get_db)):
    """Poll the status of a background generation run (DB-backed, works across workers)."""
    from server.services.generation_service import background_status

    return background_status(db, project_id)


@router.post("/{project_id}/intake/genie")
def intake_genie(
    project_id: str,
    body: GenieIntakeRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_forwarded_access_token: str | None = Header(default=None),
):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not body.questions:
        raise HTTPException(status_code=400, detail="No questions provided")
    from server.services.genie_service import run_genie_for_project

    # Prefer the logged-in user's forwarded token (Databricks Apps user authorization)
    # so Genie conversations appear in *their* Genie One history and use their data grants.
    user_token = x_forwarded_access_token or request.headers.get("x-forwarded-access-token")
    try:
        return run_genie_for_project(db, project_id, [q.model_dump() for q in body.questions], user_token=user_token)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Genie intake failed: {e}") from e


@router.post("/{project_id}/intake/mlflow")
def intake_mlflow(project_id: str, body: MlflowIntakeRequest, db: Session = Depends(get_db)):
    if A.get_project_or_none(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from server.services.mlflow_intake_service import ingest_experiment

    try:
        return ingest_experiment(db, project_id, body.experiment_id, body.max_traces, body.filter_string)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"MLflow intake failed: {e}") from e
