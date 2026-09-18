"""MLflow experiment-ID intake — pull traces from an experiment and store each as an
Item (question = request) + Response (agent output), linked by mlflow_trace_id.

Ports the request/response extraction from the VibeScaler POC's mlflow_intake_service.
`include_spans=False` avoids downloading full spans (the storage proxy is often unreachable
from an app); server-side previews are used, with a JSON-content fallback.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy.orm import Session

from server.database import Item, ItemSource, Response

logger = logging.getLogger(__name__)


_CONTENT_KEYS = ("content", "question", "input", "query", "output", "response", "text", "answer", "prompt")


def _extract_content(raw) -> str:
    """Pull human-readable text from a trace request/response (str or JSON messages)."""
    if raw is None:
        return ""
    if isinstance(raw, str):
        s = raw.strip()
        if not (s.startswith("{") or s.startswith("[") or (s.startswith('"') and s.endswith('"'))):
            return s
        try:
            raw = json.loads(s)  # unwrap JSON object/array or a quoted-string literal
        except json.JSONDecodeError:
            return s
        if isinstance(raw, str):  # was a quoted string literal
            return raw
    if isinstance(raw, dict):
        # OpenAI-style {messages:[{role,content}]}
        msgs = raw.get("messages")
        if isinstance(msgs, list) and msgs:
            last = msgs[-1]
            if isinstance(last, dict) and "content" in last:
                return str(last["content"])
        for key in _CONTENT_KEYS:
            if key in raw and isinstance(raw[key], (str, int, float)):
                return str(raw[key])
        return json.dumps(raw)[:2000]
    if isinstance(raw, list) and raw:
        return _extract_content(raw[-1])
    return str(raw)


def ingest_experiment(db: Session, project_id: str, experiment_id: str, max_traces: int = 50,
                      filter_string: str | None = None) -> dict:
    import mlflow

    mlflow.set_tracking_uri("databricks")
    traces = mlflow.search_traces(
        locations=[experiment_id],
        max_results=max_traces,
        filter_string=filter_string or None,
        return_type="list",
        include_spans=False,
    )
    created = 0
    for tr in traces:
        info = getattr(tr, "info", None)
        data = getattr(tr, "data", None)
        raw_req = getattr(info, "request_preview", None) or (getattr(data, "request", None) if data else None)
        raw_resp = getattr(info, "response_preview", None) or (getattr(data, "response", None) if data else None)
        question = _extract_content(raw_req).strip()
        answer = _extract_content(raw_resp).strip()
        if not question:
            continue
        trace_id = getattr(info, "trace_id", None) or getattr(info, "request_id", None)
        item = Item(
            project_id=project_id,
            question=question,
            expected_answer=None,  # traces carry no answer key; add via CSV/expectations later
            source=ItemSource.MLFLOW,
            mlflow_trace_id=trace_id,
            item_metadata={"experiment_id": experiment_id},
        )
        db.add(item)
        db.flush()
        if answer:
            db.add(Response(item_id=item.id, response_text=answer, mlflow_trace_id=trace_id))
        created += 1
    db.commit()
    return {"items_created": created, "detail": f"Imported {created} trace(s) from experiment {experiment_id}."}
