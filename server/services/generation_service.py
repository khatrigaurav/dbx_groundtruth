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
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from sqlalchemy.orm import Session

from server.database import GenerationMode, GenerationRun, Item, Project
from server.services import experiment_service as EXP

logger = logging.getLogger(__name__)

# A "running" row not refreshed within this window is considered orphaned (worker died — e.g.
# an app restart/deploy). The cancel-watcher refreshes updated_at every _LIVENESS_BEAT_S while a
# run is alive, so liveness is independent of how long individual Genie questions take (a slow
# batch won't be falsely reaped).
_STALE_SECONDS = 360
_LIVENESS_BEAT_S = 30

# How many questions to run through Genie at once. Genie polling is I/O-bound, so concurrency
# cuts wall-clock ~linearly until the Genie space's SQL warehouse or the serving endpoint
# becomes the bottleneck. Tune via GENERATION_CONCURRENCY in databricks.yml; the cap guards
# against a runaway value.
_DEFAULT_CONCURRENCY = 20
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


def request_cancel(db: Session, project_id: str) -> dict:
    """Signal an in-progress run to stop. A watcher thread in the worker picks this up and
    flips an in-memory event that aborts in-flight Genie polls, so the run stops within a
    couple of seconds and is marked 'cancelled'."""
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
        # Lakebase reads timestamps back tz-naive; treat a naive value as UTC so the subtraction
        # below doesn't raise "can't subtract offset-naive and offset-aware datetimes".
        updated = run.updated_at
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=_dt.timezone.utc)
        age = (_dt.datetime.now(_dt.timezone.utc) - updated).total_seconds()
        if age > _STALE_SECONDS:
            run.status = status = "error"
            run.detail = "Generation was interrupted (likely an app restart or timeout). Please run it again."
            db.commit()
    return {
        "status": status, "mode": run.mode, "total": run.total or 0,
        "generated": run.generated or 0, "detail": run.detail,
        "phase": run.phase, "graded": run.graded or 0, "grade_total": run.grade_total or 0,
        "errors": json.loads(run.errors) if run.errors else [],
    }


def _pending_items(db: Session, project_id: str, item_ids: list[str] | None) -> list[Item]:
    q = db.query(Item).filter(Item.project_id == project_id)
    if item_ids:
        q = q.filter(Item.id.in_(item_ids))
    return [it for it in q.all() if not it.responses]


def generate(db: Session, project_id: str, mode: GenerationMode,
             item_ids: list[str] | None = None, user_token: str | None = None,
             then_grade: bool = False) -> dict:
    """Start a background run. When then_grade is set, the same worker grades with the AI judges
    immediately after generation finishes (the "Generate answers and grade" pipeline). With no
    questions left to generate, it still starts — going straight to the grading phase."""
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
    if not items and not then_grade:
        return {**common, "detail": "No questions awaiting an answer."}

    existing = _get_run(db, project_id)
    if existing and existing.status in ("running", "cancelling"):
        return {**common, "detail": "A run is already in progress."}

    ids = [it.id for it in items]
    # Only "Run as me" uses the forwarded OBO token; Background runs as the SP (token=None).
    worker_token = user_token if mode == GenerationMode.USER else None
    phase = "generating" if ids else "grading"
    _write_run(db, project_id, status="running", mode=mode.value, total=len(ids),
               generated=0, phase=phase, graded=0, grade_total=0, detail=None, errors=None)
    t = threading.Thread(target=_worker,
                         args=(project_id, ids, exp_id, mode.value, worker_token, then_grade), daemon=True)
    t.start()
    where = "in your Genie One history" if mode == GenerationMode.USER else "as the app service principal (not in your Genie One history)"
    if ids:
        detail = f"Generating {len(ids)} answer(s) via Genie, {where}."
        if then_grade:
            detail += " Then grading with your AI judges automatically."
    else:
        detail = "Grading existing answers with your AI judges…"
    return {**common, "detail": detail}


def _worker(project_id: str, item_ids: list[str], exp_id: str | None, mode: str,
            user_token: str | None, then_grade: bool = False) -> None:
    from server.config import get_oauth_token, get_workspace_host
    from server.database import SessionLocal, get_engine
    from server.services import genie_service as G

    get_engine()
    assert SessionLocal is not None
    db = SessionLocal()

    # A cancel is written to the DB row from another request/gunicorn worker. A watcher thread
    # polls that (on its OWN session — pool threads must never touch `db`) and flips an in-memory
    # event; the event is checked both between questions and *inside* each Genie poll loop, so a
    # cancel stops in-flight questions within ~2s rather than after their poll completes.
    cancel_event = threading.Event()
    stop_watch = threading.Event()

    def _watch_cancel() -> None:
        wdb = SessionLocal()
        last_beat = time.monotonic()
        try:
            while not stop_watch.wait(2.0):
                wdb.expire_all()
                run = wdb.query(GenerationRun).filter(GenerationRun.project_id == project_id).first()
                if run is None:
                    continue
                if run.status == "cancelling":
                    cancel_event.set()
                    return
                # Liveness: refresh updated_at periodically so a slow-but-healthy run (long Genie
                # answers, few completions) isn't mistaken for an orphaned/dead worker and reaped.
                now = time.monotonic()
                if run.status == "running" and now - last_beat >= _LIVENESS_BEAT_S:
                    run.updated_at = _dt.datetime.now(_dt.timezone.utc)
                    wdb.commit()
                    last_beat = now
        finally:
            wdb.close()

    watcher = threading.Thread(target=_watch_cancel, daemon=True)
    watcher.start()

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
                return iid, G.answer_for_question(question, token, mcp_url, model,
                                                  cancel_check=cancel_event.is_set), None
            except G.GenerationCancelled:
                return iid, None, "__cancelled__"
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
                if cancel_event.is_set():  # cancel: start no more, drop in-flight, mark cancelled
                    pool.shutdown(wait=False, cancel_futures=True)
                    _write_run(db, project_id, status="cancelled", generated=generated,
                               detail=f"Cancelled. Generated {generated} answer(s) before stopping.",
                               errors=json.dumps(errs) if errs else None)
                    return
                iid, res, err = fut.result()
                if err == "__cancelled__":  # aborted in-flight; the event check above handles the rest
                    continue
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

        detail = (f"Generated {generated} answer(s) via Genie." if item_ids
                  else "")
        if errs:
            detail += f" {len(errs)} failed."
        if mode == "user" and generated > 0:
            detail += " These appear in your Genie One history."
        if generated == 0 and errs and any("403" in e for e in errs):
            who = "your identity (OBO token)" if user_token else "the app service principal"
            hint = ("your token was accepted but isn't authorized for Genie" if user_token else
                    "the service principal can't call Genie (check its Genie/UC access).")
            detail = f"All Genie calls returned 403, running as {who}: {hint}"

        # Pipeline: grade with the AI judges right after generation, in the same worker.
        if then_grade and not cancel_event.is_set():
            from server.services.judge_service import grade_project

            _write_run(db, project_id, phase="grading", generated=generated,
                       detail=(detail + " Grading with AI judges…").strip(),
                       errors=json.dumps(errs) if errs else None)

            def _grade_progress(done: int, total: int) -> None:
                _write_run(db, project_id, graded=done, grade_total=total)

            try:
                gr = grade_project(db, project_id, progress_cb=_grade_progress,
                                   cancel_check=cancel_event.is_set)
                detail = (detail + " " + (gr.get("detail") or "")).strip()
                for e in (gr.get("errors") or []):
                    errs.append(e)
                # Log an Evaluation Run (replay of the just-computed verdicts) — the single MLflow
                # surface: it creates + scores traces atomically and fills the Evaluations tab.
                from server.services.mlflow_eval import run_evaluation_safe
                run_evaluation_safe(db, project_id)
            except Exception as e:  # noqa: BLE001
                logger.exception("grading phase failed for project %s", project_id)
                errs.append(f"grading: {e}")
                detail = (detail + " Grading failed — see errors.").strip()
            final_status = "cancelled" if cancel_event.is_set() else "done"
            _write_run(db, project_id, status=final_status, phase="grading", generated=generated,
                       detail=detail, errors=json.dumps(errs) if errs else None)
        else:
            _write_run(db, project_id, status="done", phase="generating", generated=generated,
                       detail=detail or f"Generated {generated} answer(s).",
                       errors=json.dumps(errs) if errs else None)
    except Exception as e:  # noqa: BLE001
        logger.exception("generation worker failed for project %s", project_id)
        _write_run(db, project_id, status="error", detail=str(e), errors=json.dumps([str(e)]))
    finally:
        stop_watch.set()  # release the cancel watcher
        db.close()
