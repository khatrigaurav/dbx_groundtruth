"""Genie One MCP intake — run questions through the workspace Genie MCP server and
store each grounded answer as an Item + Response.

Ports the proven GenieMCP client from the VibeScaler POC
(vibescaler-genie-traces/genie_agent.py): initialize -> genie_ask -> genie_poll_response,
then an optional LLM synthesis step. MLflow tracing is best-effort (logged only when an
experiment is bound via MLFLOW_EXPERIMENT_ID) and never blocks intake.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid

from sqlalchemy.orm import Session

from server.config import get_oauth_token, get_workspace_host
from server.database import Item, ItemSource, Response

logger = logging.getLogger(__name__)

POLL_TIMEOUT_S = int(os.environ.get("GENIE_POLL_TIMEOUT_S", "300"))

# Transient-error backoff for Genie MCP calls, so higher generation concurrency degrades
# gracefully (retry) instead of failing questions when the endpoint/warehouse throttles.
_HTTP_MAX_RETRIES = int(os.environ.get("GENIE_HTTP_MAX_RETRIES", "4"))
_HTTP_BACKOFF_BASE = 1.0
_HTTP_BACKOFF_CAP = 20.0
_RETRY_STATUS = (429, 500, 502, 503, 504)

# Poll cadence for Genie answers. The wait between polls is sliced into short ticks so a
# cancel is honored within ~_CANCEL_TICK_S instead of after a full poll interval.
_POLL_INTERVAL_S = 5.0
_CANCEL_TICK_S = 0.5


class GenerationCancelled(Exception):
    """Raised inside a Genie round-trip when a cancel has been signalled, so an in-flight
    question aborts promptly instead of polling to completion/timeout."""

SYNTH_SYSTEM = (
    "You are a data analyst. Answer the user's question using ONLY the Genie data result "
    "provided (it is grounded in the company's governed data). Be concise, lead with the "
    "direct answer, and cite the key numbers. Do not invent data not present in the result."
)


class GenieMCP:
    """One MCP session == one Genie conversation. Stdlib-only (urllib)."""

    def __init__(self, token: str, mcp_url: str):
        self.token = token
        self.mcp_url = mcp_url
        self.sid: str | None = None
        self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "groundtruth-genie", "version": "1.0"},
        }, capture_sid=True)
        self._notify("notifications/initialized")

    def _post(self, payload: dict) -> tuple[str | None, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.sid:
            headers["mcp-session-id"] = self.sid
        data = json.dumps(payload).encode()
        last: Exception | None = None
        for attempt in range(_HTTP_MAX_RETRIES + 1):
            req = urllib.request.Request(self.mcp_url, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return r.headers.get("mcp-session-id"), r.read().decode()
            except urllib.error.HTTPError as e:
                if e.code not in _RETRY_STATUS or attempt == _HTTP_MAX_RETRIES:
                    raise
                last = e
            except urllib.error.URLError as e:  # transient network error
                if attempt == _HTTP_MAX_RETRIES:
                    raise
                last = e
            time.sleep(min(_HTTP_BACKOFF_CAP, _HTTP_BACKOFF_BASE * (2 ** attempt)) + random.uniform(0, 0.5))
        raise last  # pragma: no cover — loop always returns or raises above

    @staticmethod
    def _parse(body: str) -> dict:
        body = body.strip()
        if body.startswith("{"):
            return json.loads(body)
        for line in reversed(body.splitlines()):
            if line.startswith("data:"):
                return json.loads(line[len("data:"):].strip())
        raise RuntimeError(f"unparseable MCP response: {body[:200]}")

    def _notify(self, method: str) -> None:
        self._post({"jsonrpc": "2.0", "method": method})

    def _rpc(self, method: str, params: dict, capture_sid: bool = False) -> dict:
        sid, body = self._post({"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params})
        if capture_sid and sid:
            self.sid = sid
        msg = self._parse(body)
        if "error" in msg:
            raise RuntimeError(f"MCP error: {msg['error']}")
        return msg["result"]

    def call_tool(self, name: str, arguments: dict) -> dict:
        return self._rpc("tools/call", {"name": name, "arguments": arguments})


def _tool_text(result: dict) -> str:
    return result.get("content", [{}])[0].get("text", "")


def ask_genie(question: str, token: str, mcp_url: str, poll_timeout_s: int | None = None,
              cancel_check=None) -> dict:
    """Full Genie One MCP round-trip. Returns {answer_markdown, generated_sql}.

    If `cancel_check` (a no-arg callable) is given, it's polled throughout the wait loop and the
    round-trip aborts with GenerationCancelled the moment it returns True — so a cancel stops
    in-flight questions instead of letting them poll to completion/timeout."""
    if cancel_check and cancel_check():
        raise GenerationCancelled()
    g = GenieMCP(token, mcp_url)
    res = g.call_tool("genie_ask", {"question": question})
    sc = res.get("structuredContent", {})
    cid, rid = sc["conversation_id"], sc["response_id"]

    deadline = time.time() + (poll_timeout_s or POLL_TIMEOUT_S)
    text = ""
    while time.time() < deadline:
        if cancel_check and cancel_check():
            raise GenerationCancelled()
        res = g.call_tool("genie_poll_response", {"conversation_id": cid, "response_id": rid})
        text = _tool_text(res)
        if re.search(r"\*\*Status:\*\*\s*completed", text, re.I):
            break
        if re.search(r"\*\*Status:\*\*\s*failed", text, re.I):
            raise RuntimeError("Genie response failed")
        # Slice the wait so a cancel is honored within ~_CANCEL_TICK_S, not a whole poll interval.
        waited = 0.0
        while waited < _POLL_INTERVAL_S:
            if cancel_check and cancel_check():
                raise GenerationCancelled()
            time.sleep(_CANCEL_TICK_S)
            waited += _CANCEL_TICK_S
    else:
        raise TimeoutError(f"Genie poll timed out after {poll_timeout_s or POLL_TIMEOUT_S}s")
    sql = "\n".join(re.findall(r"```sql\n(.*?)```", text, re.S)).strip()
    return {"answer_markdown": text, "generated_sql": sql}


def _synthesize(question: str, genie_markdown: str, model: str) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=get_oauth_token(), base_url=f"{get_workspace_host()}/serving-endpoints",
                    max_retries=_HTTP_MAX_RETRIES)  # SDK backs off on 429/5xx from the serving endpoint
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYNTH_SYSTEM},
            {"role": "user", "content": f"Question:\n{question}\n\nGenie data result (markdown):\n{genie_markdown}"},
        ],
        max_tokens=700,
    )
    return resp.choices[0].message.content or ""


def _log_trace(experiment_id: str | None, question: str, answer: str, sql: str,
               expected: str | None) -> str | None:
    """Log one Genie Q→A as an MLflow trace in the project experiment, with the answer key
    as an expectation. Best-effort — returns the trace id or None, never raises."""
    if not experiment_id:
        return None
    try:
        import mlflow

        mlflow.set_tracking_uri("databricks")
        mlflow.set_experiment(experiment_id=experiment_id)
        with mlflow.start_span(name="genie_answer", span_type="AGENT") as span:
            span.set_inputs({"question": question})
            span.set_outputs({"answer": answer, "generated_sql": sql})
        trace_id = mlflow.get_last_active_trace_id()
        if trace_id and expected:
            mlflow.log_expectation(trace_id=trace_id, name="expected_answer", value=expected)
        return trace_id
    except Exception as e:  # noqa: BLE001
        logger.warning("trace logging failed for %r: %s", question[:60], e)
        return None


def run_genie_for_project(db: Session, project_id: str, questions: list[dict],
                          user_token: str | None = None, experiment_id: str | None = None) -> dict:
    """questions: [{"question": str, "expected_answer": str|None}]. Creates Item+Response each.

    If `user_token` is provided (the logged-in user's forwarded token), Genie runs
    on-behalf-of that user — conversations then appear in their Genie One history and use
    their data permissions. Otherwise it falls back to the app service principal.

    When `experiment_id` is set, each Q→A is also logged as an MLflow trace with the
    expected answer attached as an expectation.
    """
    host = get_workspace_host().rstrip("/")
    mcp_url = f"{host}/api/2.0/mcp/genie"
    token = user_token or get_oauth_token()
    model = os.environ.get("SERVING_ENDPOINT", "databricks-claude-sonnet-5")

    created = 0
    errors: list[str] = []
    for q in questions:
        question = (q.get("question") or "").strip()
        if not question:
            continue
        expected = (q.get("expected_answer") or None)
        try:
            bundle = ask_genie(question, token, mcp_url)
            answer = _synthesize(question, bundle["answer_markdown"], model)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{question[:40]}: {e}")
            logger.warning("Genie run failed for %r: %s", question[:60], e)
            continue

        sql = bundle.get("generated_sql", "")
        trace_id = _log_trace(experiment_id, question, answer, sql, expected)
        item = Item(
            project_id=project_id,
            question=question,
            expected_answer=expected,
            source=ItemSource.GENIE,
            mlflow_trace_id=trace_id,
            item_metadata={"generated_sql": sql},
        )
        db.add(item)
        db.flush()
        db.add(Response(item_id=item.id, response_text=answer,
                        model_name=f"genie+{model}", mlflow_trace_id=trace_id))
        created += 1
    db.commit()
    detail = f"Ran {created} question(s) through Genie."
    if errors:
        detail += f" {len(errors)} failed."
    return {"items_created": created, "errors": errors[:5], "detail": detail}


def answer_for_question(question: str, token: str, mcp_url: str, model: str,
                        cancel_check=None) -> dict:
    """Network-only: run ONE question through Genie + synthesis. No DB, no MLflow — safe to
    run concurrently across a thread pool. `cancel_check` aborts an in-flight Genie poll.
    Returns {answer, generated_sql}."""
    bundle = ask_genie(question, token, mcp_url, cancel_check=cancel_check)
    answer = _synthesize(question, bundle["answer_markdown"], model)
    return {"answer": answer, "generated_sql": bundle.get("generated_sql", "")}


def attach_response(db: Session, item, answer: str, sql: str, model: str,
                    experiment_id: str | None = None) -> None:
    """Persist a generated answer onto an EXISTING Item (Response + MLflow trace/expectation),
    in place. Call from a single thread — SQLAlchemy sessions and MLflow tracing are not
    concurrency-safe, so generation fans out the network calls but persists serially."""
    trace_id = _log_trace(experiment_id, item.question, answer, sql, item.expected_answer)
    if item.mlflow_trace_id is None:
        item.mlflow_trace_id = trace_id
    meta = dict(item.item_metadata or {})
    meta["generated_sql"] = sql
    item.item_metadata = meta
    db.add(Response(item_id=item.id, response_text=answer,
                    model_name=f"genie+{model}", mlflow_trace_id=trace_id))
    db.commit()
