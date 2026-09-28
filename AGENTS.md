# AGENTS.md — migrating GroundTruth to a new Databricks workspace

Instructions for a coding agent (or a person) tasked with deploying this app into a fresh
Databricks workspace. Follow these in order. Everything the deploy needs is in this repo;
nothing about a specific workspace is hardcoded in code — the workspace comes from the CLI
profile, and per-workspace values are bundle variables.

If you only need product/usage docs, read `README.md` instead. This file is the **migration
runbook**.

---

## 0. What this is (context you need)

- A Databricks App: **FastAPI backend + React/Vite SPA** (SPA is built to `client/dist` and
  served by FastAPI). Deployed via the **Databricks Asset Bundle** in `databricks.yml`.
- **Data:** SQLAlchemy ORM — SQLite locally, **Lakebase (Postgres)** in the workspace. The
  schema **auto-creates on first boot** (`Base.metadata.create_all()` into the `groundtruth`
  schema), so there is **no migration step and no seed data** — a fresh deploy starts empty.
- **Identity:** Databricks Apps SSO. No passwords, no committed credentials. Any signed-in user
  who can reach the app is a facilitator; control that via the app's Databricks permissions.

## 1. Preconditions (verify before deploying)

- **Databricks CLI v0.265.0+** (needs `database_instances` support). Check `databricks --version`.
- **Node 18+** on the deploy machine. The bundle builds the SPA during `deploy`
  (`artifacts.frontend` → `cd client && npm ci && npm run build`). Do **not** hand-build or
  hand-edit `client/dist`; the bundle regenerates it.
- Authenticated to the **target** workspace:
  `databricks auth login --host <workspace-url> --profile <PROFILE>`
- In the target workspace you can create: a **Lakebase instance**, an **MLflow experiment**, and
  a **Databricks App**; and you can read a **SQL warehouse** and a **model-serving endpoint**.
- A **Claude serving endpoint** exists (default name `databricks-claude-sonnet-5`) and a
  **running SQL warehouse** exists — get its ID.

## 2. The only edits you make per workspace

Edit **`databricks.yml` → `targets`**. Pick the `samsara` target (or add your own) and set:

```yaml
targets:
  samsara:
    variables:
      serving_endpoint: databricks-claude-sonnet-5      # your workspace's Claude endpoint name
      warehouse_id: <YOUR_WAREHOUSE_ID>                 # any running SQL warehouse in the target
```

That is the whole code change. Do **not**:
- add `mode: development` — its `[dev ...]` name-prefixing renames the Lakebase instance and
  breaks the `ENDPOINT_NAME` path derived from it (see the comment in `databricks.yml`);
- rename the Lakebase instance `groundtruth-db` — `ENDPOINT_NAME` is built from that name;
- hardcode a workspace host anywhere — it comes from `-p <profile>`.

## 3. Deploy

```bash
PROFILE=<your-profile>     # supplies the workspace host
TARGET=samsara             # the target you edited in step 2

databricks bundle validate -t "$TARGET" -p "$PROFILE"
databricks bundle deploy   -t "$TARGET" -p "$PROFILE"
```

The single `deploy` builds the SPA, creates the Lakebase instance `groundtruth-db` and the
MLflow experiment `/Shared/groundtruth-intake`, syncs the source to `${workspace.file_path}`,
and creates/updates the app `groundtruth` with its resource bindings (`database`,
`sql-warehouse`, `serving-endpoint`, `experiment`) and env (see `databricks.yml` → `apps` →
`config.env`). The `PGHOST/PGUSER/PGPORT/PGDATABASE` and the `value_from` env keys resolve from
those bindings automatically.

## 4. Post-deploy workspace settings the bundle does NOT do

The bundle creates resources and the app, but these are **workspace/account-level** and must be
set once by an admin — otherwise generation features fail even though the app is up:

1. **Allow the `genie` user API scope.** The app requests `user_api_scopes: [genie]`. The
   workspace setting `allowedAppsUserApiScopes` must permit `genie`, or "Run as me" (OBO)
   generation can't forward the user token to the Genie MCP server.
2. **Share the Genie space + its warehouse + referenced UC tables** with each user who will run
   "Run as me" generation (OBO uses their grants).
3. **Grant the app service principal** SELECT on the UC data Genie queries — this is what
   **Background (service principal)** generation runs as. Without it, background generation 403s.
   (Find the app SP via `databricks apps get groundtruth -p "$PROFILE"`.)
4. **Grant the app SP `CAN QUERY`** on the serving endpoint if the binding didn't already (the
   bundle binds it; verify in the app's resource list).

If OBO isn't enabled, Background (SP) generation is the working default — it just doesn't appear
in the user's Genie One history.

## 5. Verify

```bash
databricks apps get groundtruth -p "$PROFILE"     # prints the app URL + the app SP
```

- Open the URL, hit `/api/health` (should be OK).
- Log in (SSO recognizes you on load — there is no login form) and create a test project.
- Upload the checked-in `sample_eval_v2.csv` (or the answer-sheet format in `README.md`),
  generate Genie answers, grade with the AI judge, review a couple by hand, then open the
  **Compare results** step. If the comparison scorecard renders, the full path works.

## 6. What does NOT carry over

- **Runtime data** (projects, items, responses, judgments) lives only in the source workspace's
  Lakebase. A new deploy starts **empty**. Export/import it separately if it's worth keeping.
- **No demo/seed data** ships in the repo (Phase 4 was never built). Expect a blank app.

## 7. Where things live (for edits)

- `databricks.yml` — **authoritative** for the app command, all env vars, resource creation, and
  bindings. Per-workspace values are the `targets` variables. Start here.
- `app.yaml` — a minimal local-dev stub (start command only); the bundle `config` overrides it
  on deploy. Don't put real config here.
- `server/` — FastAPI app. `server/app.py` (mounts, static-file serving, `/api/health`),
  `server/routers/` (auth, intake, items, judge, review, projects), `server/services/`
  (generation, genie, judge, metrics, mlflow, summary, experiment).
- `client/src/` — React SPA. `pages/` (Projects, ProjectDetail, Review, Results, Compare, Login),
  `lib/api.ts` (API client + session).
- `README.md` — product/usage + data-source formats (answer sheet, Genie, MLflow) + comparison.

## 8. Local sanity loop (optional, no workspace needed)

```bash
uv venv --python 3.11 && uv pip install -r requirements.txt
cd client && npm install && cd ..
export DATABASE_ENV=sqlite DEV_FACILITATOR_EMAIL=you@databricks.com DATABRICKS_PROFILE=<profile>
uv run uvicorn server.app:app --reload --port 8000   # backend
cd client && npm run dev                              # frontend at :5173, proxies /api
```

**Verify frontend before committing:** `cd client && npx tsc -b && npm run build`.
Backend one-off snippets: `uv run --with sqlalchemy --with pydantic python -` (system python3
lacks these).

## 9. Repo conventions (if you commit)

- Work happens on `main`.
- End commit messages with: `Co-authored-by: Isaac <no-reply@databricks.com>`
- End PR descriptions with: `This pull request and its description were written by Isaac.`
