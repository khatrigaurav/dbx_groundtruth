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
export DATABRICKS_PROFILE=<your-profile>
# Off-platform there are no Databricks SSO headers, so stand in for the signed-in identity:
export DEV_FACILITATOR_EMAIL=you@databricks.com
uv run uvicorn server.app:app --reload --port 8000

# Frontend dev server (proxies /api -> :8000)
cd client && npm run dev        # http://localhost:5173

# Production-style: build the SPA and let FastAPI serve it at :8000
cd client && npm run build && cd .. && uv run uvicorn server.app:app --port 8000
```

**Auth:** identity comes from Databricks Apps SSO — no passwords, no committed credentials.
Any signed-in Databricks user who can reach the app is a **facilitator**; restrict who that is
via the app's Databricks permissions. There is no login form (the app recognizes you on load
via `/auth/whoami`). Locally, `DEV_FACILITATOR_EMAIL` stands in for the SSO identity.
**Reviewers** are still invited by email to a project (recorded against their real SSO email
for attribution), but membership is no longer an access gate.

## Data sources (intake)
- **Answer sheet (pipe-delimited)** — `|`-separated columns (case-insensitive): `question` (required) · `expected_answer` · `response` · `model`. Pipe-delimited (not comma) so questions/answers can contain commas without quoting. Accepts `.csv`/`.txt`/`.psv`.
- **Genie One (MCP)** — one question per line; optional answer key as `question | expected`. Runs each through
  the workspace Genie MCP server and synthesizes a grounded answer. (App SP needs SELECT on the queried UC data.)
- **MLflow experiment** — enter an experiment id + max traces; imports request→Item, response→Response.

## Deployment

Deploy to **any Databricks workspace** as a Databricks App via the **Asset Bundle**
(`databricks.yml`): one command creates the Lakebase instance and MLflow experiment, binds
them (plus the warehouse and serving endpoint) to the app, syncs the source, and deploys.
Nothing is workspace-specific in the repo — the host comes from your CLI profile and the
per-workspace values are bundle variables. That is what makes the **Phase 4 handover to
Samsara a config edit, not a code edit**.

### 0. Prerequisites
- Databricks CLI **v0.265.0+** (`database_instances` support). Check: `databricks --version`.
- Authenticated to the target workspace: `databricks auth login --host <workspace-url> --profile <PROFILE>`
- Node 18+ on the deploy machine — the bundle builds the frontend automatically during
  `deploy` (see step 2). No manual npm steps.
- Permission to create a Lakebase instance, an MLflow experiment, and a Databricks App,
  and to read a SQL warehouse + model-serving endpoint in that workspace.

### 1. Set the per-workspace variables
Edit `databricks.yml` → `targets`. Nothing else needs changing to move workspaces:
- `warehouse_id` — any running SQL warehouse in the target workspace (Phase 3 UC trace search).
- `serving_endpoint` — defaults to `databricks-claude-sonnet-5`; change if the workspace's
  Claude endpoint has a different name.

The `dev` target is Gaurav's; the `samsara` target is the handover slot — Samsara fills in
their own `warehouse_id` and deploys with their own profile.

> The bundle creates the Lakebase instance named **`groundtruth-db`** and derives
> `ENDPOINT_NAME` from it, so the endpoint path is always valid. We deliberately do **not**
> use `mode: development` — its `[dev ...]` name-prefixing would rename the instance and
> break that path.
>
> Lakebase note: if a **fresh UC catalog** errors with `DAC_DOES_NOT_EXIST`, use an existing
> catalog that already has metastore root storage — this bit the sibling VibeScaler deploy.

### 2. Deploy the bundle (builds the frontend for you)

```bash
PROFILE=<your-profile>          # supplies the workspace host — nothing hardcoded
TARGET=dev                      # or `samsara` for the handover

databricks bundle validate -t "$TARGET" -p "$PROFILE"   # sanity check
databricks bundle deploy   -t "$TARGET" -p "$PROFILE"    # builds + creates resources + deploys
```

That single `deploy` will:
1. **Build the React SPA** — the `artifacts.frontend` step runs `npm ci && npm run build` in
   `client/` before syncing, so `client/dist` is always current. No manual npm step, and no
   stale-build drift.
2. Create the Lakebase instance `groundtruth-db` and the MLflow experiment `/Shared/groundtruth-intake`.
3. Sync the source to `${workspace.file_path}` (respects `.gitignore`: skips `.venv`, `node_modules`).
4. Create/update the app `groundtruth`, attaching `database`, `sql-warehouse`,
   `serving-endpoint`, and `experiment` — so the app's `value_from` keys and injected
   `PGHOST/PGUSER/PGPORT/PGDATABASE` all resolve automatically.

To override the warehouse without editing the file: `... deploy -t dev --var warehouse_id=<id>`.

### 3. Verify
- App URL: `databricks apps get groundtruth -p "$PROFILE"` (form `https://groundtruth-<workspace-id>.aws.databricksapps.com`).
- **Schema auto-creates on startup** — `gunicorn_conf.py:on_starting` runs
  `bootstrap_database()` (`Base.metadata.create_all`) once before workers fork. The empty
  `migrations/versions/` is expected, not broken.
- Hit `/api/health`, then log in as the facilitator and create a test project.
- If DB reads fail with `relation "..." does not exist` despite tables existing, it's the
  `search_path` pooling issue — the fix (commit after `SET search_path`) is already in
  `server/db_config.py`; confirm the deployed code matches this repo.

### Config sources (where things live)
- `databricks.yml` — **authoritative** for the app command + all env vars + resource
  creation and bindings. Edit workspace-specific values here (in `targets`).
- `app.yaml` — a minimal local-dev stub (start command only). The bundle `config` overrides
  it on deploy; it exists only so a bare `databricks apps deploy` still launches.

### What does NOT carry over
- **Runtime data** (projects / items / judgments) lives only in the previous workspace's
  Lakebase `groundtruth-db`. It is not in git — export it before the old workspace is
  terminated if you need it. A fresh deploy starts empty (no seed data).

## Status
- [x] Phase 0 — scaffold, dual-mode auth, schema bootstrap, health
- [x] Phase 1 — CSV answer-sheet import, human review loop, results + agreement
- [x] Phase 2 — LLM correctness judge (`POST /api/projects/{id}/run-judge`)
- [x] Phase 3 — Genie One MCP question-runner + MLflow experiment-ID intake
- [x] Deploy — Databricks Asset Bundle (`databricks.yml`): one `databricks bundle deploy`
      creates the Lakebase instance + MLflow experiment, binds resources, and deploys the
      app. No workspace hardcoded — host from the CLI profile, per-workspace values are
      bundle variables. See **Deployment** above.
- [ ] Phase 4 — facilitator progress view, seed demo data, handoff to Samsara's workspace
      (deploy via the `samsara` bundle target — a config edit, not a code change)

Plan: `~/.claude/plans/shimmying-marinating-hamming.md`
