"""Dual-mode auth: works both inside a Databricks App and locally via a CLI profile."""

from __future__ import annotations

import os

# Databricks Apps sets DATABRICKS_APP_NAME in the runtime environment.
IS_DATABRICKS_APP = bool(os.environ.get("DATABRICKS_APP_NAME"))


def chat_content_text(content) -> str:
    """Normalize an OpenAI-compatible chat message's `content` to plain text.

    Claude models served through the Databricks OpenAI-compatible shim can return `content`
    as a list of content parts (e.g. [{"type": "text", "text": "..."}]) instead of a string.
    Calling `.strip()` on that list raised "'list' object has no attribute 'strip'". This
    accepts a str, a list of parts (dicts or objects with a `.text`), or None.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
            else:
                parts.append(str(getattr(p, "text", "") or ""))
        return "".join(parts)
    return str(content)


def get_workspace_client():
    from databricks.sdk import WorkspaceClient

    if IS_DATABRICKS_APP:
        return WorkspaceClient()  # auto-injected service-principal creds
    profile = os.environ.get("DATABRICKS_PROFILE", "DEFAULT")
    return WorkspaceClient(profile=profile)


def get_workspace_host() -> str:
    """Workspace host WITH scheme. In Apps, DATABRICKS_HOST is a bare hostname."""
    if IS_DATABRICKS_APP:
        host = os.environ.get("DATABRICKS_HOST", "")
        if host and not host.startswith("http"):
            host = f"https://{host}"
        return host
    return get_workspace_client().config.host


def get_oauth_token() -> str:
    """Bearer token for serving-endpoints / MLflow. Handles U2M where .token is None."""
    if IS_DATABRICKS_APP:
        tok = os.environ.get("DATABRICKS_TOKEN")
        if tok:
            return tok
    client = get_workspace_client()
    headers = client.config.authenticate()
    if headers and "Authorization" in headers:
        return headers["Authorization"].replace("Bearer ", "")
    return client.config.token or ""
