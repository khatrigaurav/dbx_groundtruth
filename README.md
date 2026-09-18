# GroundTruth

A simple answer-key evaluation app: import questions + expected answers, collect agent
responses, and grade them with an **LLM correctness judge** and **human reviewers** — then
compare the two. Built for Samsara to own and run as a customer-facing tool.

Deliberately simpler than VibeScaler: no discovery/rubric/IRR/alignment pipeline. Just
**Project → Items (question + expected answer + responses) → Judgments (llm | human)**.

## Stack
- Backend: FastAPI + SQLAlchemy (SQLite local, Lakebase Postgres in prod)
- Frontend: React + Vite + Tailwind (built to `client/dist`, served by FastAPI)
- Judge: Databricks serving endpoint (`SERVING_ENDPOINT`, default `databricks-claude-sonnet-5`)

## Local development

```bash
# One-time
uv venv --python 3.11 && uv pip install -r requirements.txt
cd client && npm install && cd ..

# Backend (SQLite). Set a profile so the LLM judge can reach a serving endpoint.
export DATABASE_ENV=sqlite
export DATABRICKS_PROFILE=fe-vm-wd-s3t-sbxclassic
uv run uvicorn server.app:app --reload --port 8000

# Frontend dev server (proxies /api -> :8000)
cd client && npm run dev        # http://localhost:5173

# Production-style: build the SPA and let FastAPI serve it at :8000
cd client && npm run build && cd .. && uv run uvicorn server.app:app --port 8000
```

**Facilitator login:** `gaurav.khatri@databricks.com` / `GroundTruth!2026` (see `config/auth.yaml`).
**Testers:** invited by email in a project, then log in with email + project (no password).

## Data sources (intake)
- **CSV answer sheet** — columns (case-insensitive): `question` (required) · `expected_answer` · `response` · `model`
- **Genie One (MCP)** — one question per line; optional answer key as `question | expected`. Runs each through
  the workspace Genie MCP server and synthesizes a grounded answer. (App SP needs SELECT on the queried UC data.)
- **MLflow experiment** — enter an experiment id + max traces; imports request→Item, response→Response.

## Status
- [x] Phase 0 — scaffold, dual-mode auth, schema bootstrap, health
- [x] Phase 1 — CSV answer-sheet import, human review loop, results + agreement
- [x] Phase 2 — LLM correctness judge (`POST /api/projects/{id}/run-judge`)
- [x] Phase 3 — Genie One MCP question-runner + MLflow experiment-ID intake
- [x] Deploy — Lakebase `groundtruth-db` + Databricks App on FEVM `wd-s3t-sbxclassic`
      → https://groundtruth-7474644194058799.aws.databricksapps.com
- [ ] Phase 4 — facilitator progress view, seed demo data, handoff to Samsara's workspace

Plan: `~/.claude/plans/shimmying-marinating-hamming.md`
