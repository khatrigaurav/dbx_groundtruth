"""GroundTruth FastAPI entry point.

Serves the API under /api and the built React SPA (client/dist) for everything else.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("groundtruth")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from server.database import bootstrap_database

    try:
        bootstrap_database()
    except Exception:  # noqa: BLE001
        logger.exception("bootstrap_database failed at startup")
    yield


app = FastAPI(title="GroundTruth", lifespan=lifespan)


@app.get("/api/health")
def health():
    from server.db_config import detect_database_backend

    return {"status": "ok", "app": "groundtruth", "backend": detect_database_backend().value}


@app.get("/api/genie-debug")
def genie_debug(request: Request):
    """Diagnose Genie MCP 403s: reports whether the user OBO token is present and what a Genie
    MCP `initialize` returns for (a) the forwarded user token and (b) the app SP token."""
    import os as _os

    from server.config import get_oauth_token, get_workspace_host

    host = get_workspace_host().rstrip("/")
    mcp_url = f"{host}/api/2.0/mcp/genie"
    user_token = request.headers.get("x-forwarded-access-token")

    def probe(token: str | None) -> dict:
        if not token:
            return {"token_present": False}
        try:
            from server.services.genie_service import GenieMCP
            GenieMCP(token, mcp_url)  # performs initialize
            return {"token_present": True, "initialize": "ok"}
        except Exception as e:  # noqa: BLE001
            return {"token_present": True, "initialize": "failed", "error": str(e)[:300]}

    sp_token = None
    try:
        sp_token = get_oauth_token()
    except Exception:  # noqa: BLE001
        sp_token = None

    def scopes_of(token: str | None) -> dict:
        """Decode the OAuth JWT and surface only its `scope` claim (never the token itself),
        so we can see whether `genie` was actually granted to the down-scoped OBO token."""
        if not token:
            return {"token_present": False}
        try:
            import base64
            import json as _json

            parts = token.split(".")
            if len(parts) < 2:
                return {"token_present": True, "is_jwt": False}  # opaque token, no claims
            payload = parts[1] + "=" * (-len(parts[1]) % 4)  # pad base64url
            claims = _json.loads(base64.urlsafe_b64decode(payload))
            scope = claims.get("scope") or claims.get("scp") or ""
            scope_list = scope.split() if isinstance(scope, str) else list(scope)
            return {"token_present": True, "is_jwt": True,
                    "scopes": scope_list, "genie_present": "genie" in scope_list}
        except Exception as e:  # noqa: BLE001
            return {"token_present": True, "is_jwt": False, "error": str(e)[:200]}

    out = {
        "mcp_url": mcp_url,
        "forwarded_header_present": bool(user_token),
        "forwarded_header_len": len(user_token) if user_token else 0,
        "user_token_scopes": scopes_of(user_token),
        "sp_token_scopes": scopes_of(sp_token),
        "as_user_obo": probe(user_token),
        "as_service_principal": probe(sp_token),
        "sp_token_available": bool(sp_token),
    }

    # ?ask=<question> → run a full Genie round-trip as the SP (bounded poll) to see if the
    # SP can actually answer (vs a data-access denial on the underlying tables).
    q = request.query_params.get("ask")
    if q and sp_token:
        try:
            from server.services.genie_service import ask_genie
            bundle = ask_genie(q, sp_token, mcp_url, poll_timeout_s=20)
            out["sp_ask"] = {"ok": True, "answer_preview": (bundle.get("answer_markdown") or "")[:500],
                             "sql": bundle.get("generated_sql", "")[:300]}
        except Exception as e:  # noqa: BLE001
            out["sp_ask"] = {"ok": False, "error": str(e)[:400]}
    return out


@app.get("/api/judge-catalog")
def judge_catalog():
    """Built-in + custom judge catalog and available judge models (for the UI picker)."""
    from server.schemas import JudgeCatalogItem
    from server.services.judge_service import AVAILABLE_JUDGE_MODELS, JUDGE_CATALOG

    return {
        "judges": [JudgeCatalogItem(**j).model_dump() for j in JUDGE_CATALOG],
        "models": AVAILABLE_JUDGE_MODELS,
    }


# --- routers -----------------------------------------------------------------
from server.routers import auth, intake, items, judge, projects, review  # noqa: E402

app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(items.router, prefix="/api")
app.include_router(intake.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(judge.router, prefix="/api")


# --- serve the React SPA -----------------------------------------------------
_client_dist = os.path.join(os.path.dirname(os.path.dirname(__file__)), "client", "dist")
if os.path.isdir(_client_dist):
    _assets = os.path.join(_client_dist, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return FileResponse(os.path.join(_client_dist, "index.html"))
else:
    logger.warning("client/dist not found (%s) — API-only mode until frontend is built", _client_dist)
