"""Gunicorn config.

Runs schema bootstrap once in the master before workers fork, then disposes the
connection pool so workers do NOT inherit live SSL/Postgres connections. Sharing a
pg8000 SSL socket across a fork corrupts TLS state (bad record mac / EOF), so each
worker must open its own connections — see post_fork.
"""

import logging

logger = logging.getLogger("groundtruth.gunicorn")

bind = "0.0.0.0:8000"
workers = 2
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 1800  # allow long-running LLM-judge / intake jobs


def on_starting(server):  # noqa: ARG001
    """Ensure schema + tables exist once, before workers fork; then drop connections."""
    try:
        from server.database import bootstrap_database, get_engine

        bootstrap_database()
        # Close the master's connections so forked workers don't inherit live
        # SSL sockets (which cannot be shared across processes).
        get_engine().dispose()
        logger.info("on_starting: bootstrap_database complete; engine disposed")
    except Exception:  # noqa: BLE001
        logger.exception("on_starting: bootstrap_database failed")


def post_fork(server, worker):  # noqa: ARG001
    """Discard any inherited pooled connections in the child (belt-and-suspenders)."""
    try:
        from server.database import get_engine

        get_engine().dispose(close=False)  # abandon inherited conns without closing parent's
    except Exception:  # noqa: BLE001
        logger.exception("post_fork: engine dispose failed")
