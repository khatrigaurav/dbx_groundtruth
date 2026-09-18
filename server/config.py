"""Dual-mode auth: works both inside a Databricks App and locally via a CLI profile."""

from __future__ import annotations

import os

# Databricks Apps sets DATABRICKS_APP_NAME in the runtime environment.
IS_DATABRICKS_APP = bool(os.environ.get("DATABRICKS_APP_NAME"))


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
