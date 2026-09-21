"""Generation orchestrator — turn a project's questions into answers via Genie One MCP.

Both generation modes run in a background worker thread and report progress via a DB row
(GenerationRun), so status survives across gunicorn workers and never blocks the request:
  • USER — the worker reuses the signed-in user's forwarded token (valid for its lifetime),
           so conversations appear in the user's Genie One history and use their data grants.
  • SP   — the worker runs as the app service principal; does NOT surface in Genie One.

Each Q→A is attached to the project's own MLflow experiment (created on first use).
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from sqlalchemy.orm import Session

from server.database import GenerationMode, GenerationRun, Item, Project
from server.services import experiment_service as EXP

logger = logging.getLogger(__name__)

# A "running" row not updated within this window is considered orphaned (worker died — e.g. an
# app restart/deploy). The worker heartbeats updated_at after each question, so a healthy run
# refreshes every ~1–2 min.
_STALE_SECONDS = 360

# How many questions to run through Genie at once. Genie polling is I/O-bound, so concurrency
# cuts wall-clock ~linearly until the Genie space's SQL warehouse or the serving endpoint
# becomes the bottleneck. Tune via GENERATION_CONCURRENCY in databricks.yml; the cap guards
# against a runaway value.
_DEFAULT_CONCURRENCY = 10
_MAX_CONCURRENCY = 25


def _concurrency() -> int:
    try:
        n = int(os.environ.get("GENERATION_CONCURRENCY", str(_DEFAULT_CONCURRENCY)))
    except ValueError:
        n = _DEFAULT_CONCURRENCY
    return max(1, min(_MAX_CONCURRENCY, n))


def _get_run(db: Session, project_id: str) -> GenerationRun | None:
    return db.query(GenerationRun).filter(GenerationRun.project_id == project_id).first()


def _write_run(db: Session, project_id: str, **fields) -> None:
    run = _get_run(db, project_id)
    if run is None:
        run = GenerationRun(project_id=project_id)
        db.add(run)
    for k, v in fields.items():
        setattr(run, k, v)
    db.commit()


def _cancel_requested(db: Session, project_id: str) -> bool:
    """Fresh read of the run status so a cancel written by another gunicorn worker/session is
    visible to the worker thread mid-run."""
    db.expire_all()
    run = _get_run(db, project_id)
    return run is not None and run.status == "cancelling"


def request_cancel(db: Session, project_id: str) -> dict:
    """Signal an in-progress run to stop. The worker checks this between questions, starts no
    new ones, and marks the run 'cancelled'. Questions already in flight finish in the
    background but their answers are discarded."""
    run = _get_run(db, project_id)
    if run is None or run.status not in ("running", "cancelling"):
        return {"status": (run.status if run else "idle"),
                "detail": "No generation is currently running."}
    run.status = "cancelling"
    run.detail = "Cancelling — no new questions will start."
    db.commit()
    return {"status": "cancelling", "detail": run.detail}


def background_status(db: Session, project_id: str) -> dict:
    run = _get_run(db, project_id)
    if run is None:
        return {"status": "idle"}
    status = run.status
    # Reap an orphaned run (worker died mid-run/mid-cancel, e.g. an app restart).
    if status in ("running", "cancelling") and run.updated_at is not None:
        age = (_dt.datetime.now(_dt.timezone.utc) - run.updated_at).total_seconds()
        if age > _STALE_SECONDS:
            run.status = status = "error"
            run.detail = "Generation was interrupted (likely an app restart or timeout). Please run it again."
            db.commit()
    return {
        "status": status, "mode": run.mode, "total": run.total or 0,
        "generated": run.generated or 0, "detail": run.detail,
        "errors": json.loads(run.errors) if run.errors else [],
    }


def _pending_items(db: Session, project_id: str, item_ids: list[str] | None) -> list[Item]:
    q = db.query(Item).filter(Item.project_id == project_id)
    if item_ids:
        q = q.filter(Item.id.in_(item_ids))
    return [it for it in q.all() if not it.responses]


def generate(db: Session, project_id: str, mode: GenerationMode,
             item_ids: list[str] | None = None, user_token: str | None = None) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found.", "generated": 0}

    common = {"mode": mode, "generated": 0,
              "surfaces_in_genie_ui": mode == GenerationMode.USER}

    if mode == GenerationMode.USER and not user_token:
        return {**common, "surfaces_in_genie_ui": False,
                "errors": ["No user token was forwarded to the app (x-forwarded-access-token missing)."],
                "detail": "Couldn't run as you — the app didn't receive your access token. "
                          "This usually means user authorization isn't fully enabled. "
                          "Use Background (service principal) mode, or we fix the app's user-auth config."}

    exp_id = EXP.ensure_experiment(db, project)
    items = _pending_items(db, project_id, item_ids)
    project.genie_last_run_mode = mode
    db.commit()

    common.update({"experiment_id": exp_id, "experiment_url": EXP.experiment_url(exp_id),
                   "genie_url": EXP.genie_url()})
    if not items:
        return {**common, "detail": "No questions awaiting an answer."}

    existing = _get_run(db, project_id)
    if existing and existing.status in ("running", "cancelling"):
        return {**common, "detail": "A generation run is already in progress."}

    ids = [it.id for it in items]
    # Only "Run as me" uses the forwarded OBO token; Background runs as the SP (token=None).
    worker_token = user_token if mode == GenerationMode.USER else None
    _write_run(db, project_id, status="running", mode=mode.value, total=len(ids),
               generated=0, detail=None, errors=None)
    t = threading.Thread(target=_worker, args=(project_id, ids, exp_id, mode.value, worker_token), daemon=True)
    t.start()
    where = "in your Genie One history" if mode == GenerationMode.USER else "as the app service principal (not in your Genie One history)"
    return {**common, "detail": f"Generating {len(ids)} answer(s) via Genie, {where}. "
                                "Answers appear here as they're produced."}


def _worker(project_id: str, item_ids: list[str], exp_id: str | None, mode: str,
            user_token: str | None) -> None:
    from server.config import get_oauth_token, get_workspace_host
    from server.database import SessionLocal, get_engine
    from server.services import genie_service as G

    get_engine()
    assert SessionLocal is not None
    db = SessionLocal()
    try:
        # Snapshot the questions to run as plain tuples BEFORE fanning out — ORM objects and the
        # db session must never cross threads.
        pending = [(it.id, (it.question or "").strip())
                   for it in db.query(Item).filter(Item.id.in_(item_ids)).all()
                   if not it.responses and (it.question or "").strip()]

        host = get_workspace_host().rstrip("/")
        mcp_url = f"{host}/api/2.0/mcp/genie"
        token = user_token or get_oauth_token()
        model = os.environ.get("SERVING_ENDPOINT", "databricks-claude-sonnet-5")

        generated = 0
        errs: list[str] = []

        def _fetch(row: tuple[str, str]):
            iid, question = row
            try:
                return iid, G.answer_for_question(question, token, mcp_url, model), None
            except Exception as e:  # noqa: BLE001
                logger.warning("Genie generate failed for %r: %s", question[:60], e)
                return iid, None, f"{question[:40]}: {e}"

        # Fan the Genie round-trips out across a bounded pool (I/O-bound polling); persist each
        # result on THIS thread as it lands, so DB writes, MLflow traces, and the progress
        # heartbeat stay single-threaded (keeps updated_at fresh so a healthy run isn't reaped).
        pool = ThreadPoolExecutor(max_workers=_concurrency())
        try:
            futures = [pool.submit(_fetch, row) for row in pending]
            for fut in as_completed(futures):
                # Between questions, honor a cancel requested from any worker/session: start no
                # more, drop in-flight results, mark cancelled.
                if _cancel_requested(db, project_id):
                    pool.shutdown(wait=False, cancel_futures=True)
                    _write_run(db, project_id, status="cancelled", generated=generated,
                               detail=f"Cancelled. Generated {generated} answer(s) before stopping.",
                               errors=json.dumps(errs) if errs else None)
                    return
                iid, res, err = fut.result()
                if err:
                    errs.append(err)
                else:
                    item = db.query(Item).filter(Item.id == iid).first()
                    if item is not None and not item.responses:
                        G.attach_response(db, item, res["answer"], res["generated_sql"],
                                          model, experiment_id=exp_id)
                        generated += 1
                # Heartbeat WITHOUT status, so it can't clobber a 'cancelling' set elsewhere.
                _write_run(db, project_id, generated=generated,
                           errors=json.dumps(errs) if errs else None)
        finally:
            pool.shutdown(wait=False)

        detail = f"Generated {generated} answer(s) via Genie."
        if errs:
            detail += f" {len(errs)} failed."
        if mode == "user" and generated > 0:
            detail += " These appear in your Genie One history."
        if generated == 0 and errs and any("403" in e for e in errs):
            who = "your identity (OBO token)" if user_token else "the app service principal"
            hint = ("your token was accepted but isn't authorized for Genie" if user_token else
                    "the service principal can't call Genie (check its Genie/UC access).")
            detail = f"All Genie calls returned 403, running as {who}: {hint}"
        _write_run(db, project_id, status="done", generated=generated,
                   detail=detail, errors=json.dumps(errs) if errs else None)
    except Exception as e:  # noqa: BLE001
        logger.exception("generation worker failed for project %s", project_id)
        _write_run(db, project_id, status="error", detail=str(e), errors=json.dumps([str(e)]))
    finally:
        db.close()
