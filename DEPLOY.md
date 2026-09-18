# Deploy / Redeploy Runbook

How to stand GroundTruth up in a **fresh Databricks workspace** as a Databricks App.
The app source is self-contained; everything below is about (re)creating the workspace-side
resources it expects and pushing the code. No bundle file — deploy is `databricks sync` +
`databricks apps deploy`.

## 0. Prerequisites
- Databricks CLI authenticated to the target workspace: `databricks auth login --host <workspace-url> --profile <PROFILE>`
- Node 18+ and `uv` (or Python 3.11) locally, to build the frontend.
- Permission to create a Lakebase instance, a Databricks App, and to read a SQL warehouse /
  MLflow experiment / model-serving endpoint in that workspace.

## 1. Create the workspace resources
These back the `app.yaml` env vars and app resources. Create them first.

| Resource | Requirement | Why |
|---|---|---|
| Lakebase instance | **Name it `groundtruth-db`** | Keeps `ENDPOINT_NAME` in `app.yaml` valid as-is. Attached as the app `database` resource → runtime injects `PGHOST/PGUSER/PGPORT/PGDATABASE`. |
| SQL warehouse | any running warehouse | Attached as app resource key `sql-warehouse` (`MLFLOW_TRACING_SQL_WAREHOUSE_ID`); used for UC trace search in Genie/MLflow intake. |
| MLflow experiment | any experiment | Attached as app resource key `experiment` (`MLFLOW_EXPERIMENT_ID`). |
| Serving endpoint | `databricks-claude-sonnet-5` must exist | LLM judge + Genie answer synthesis (`SERVING_ENDPOINT`). Change the value in `app.yaml` if the new workspace uses a different endpoint name. |

> Lakebase note: if a **fresh UC catalog** errors with `DAC_DOES_NOT_EXIST`, use an existing
> catalog that already has metastore root storage — this bit the sibling VibeScaler deploy.

## 2. Point config at the new workspace
Edit `app.yaml`:
- `APP_SOURCE_PATH` → `/Workspace/Users/<your-email>/groundtruth` in the **new** workspace.
- `ENDPOINT_NAME` → leave as `projects/groundtruth-db/branches/production/endpoints/primary`
  **if** you named the Lakebase instance `groundtruth-db` (step 1). Otherwise update the path.
- `SERVING_ENDPOINT` → change only if the new workspace's Claude endpoint has a different name.

Facilitator login stays as in `config/auth.yaml` (`gaurav.khatri@databricks.com` / `GroundTruth!2026`).

## 3. Build the frontend
`databricks sync` respects `.gitignore`, and `client/dist` is intentionally **not** ignored —
FastAPI serves the built SPA from it. Rebuild so `client/dist` is current:

```bash
cd client && npm install && npm run build && cd ..
```

## 4. Sync source + deploy the app

```bash
PROFILE=<your-profile>
DEST=/Workspace/Users/<your-email>/groundtruth   # must match APP_SOURCE_PATH

# Upload source (excludes .venv, node_modules, __pycache__ via .gitignore)
databricks sync . "$DEST" --profile "$PROFILE"

# Create the app once (skip if it already exists), then attach the resources from step 1
# (database=groundtruth-db, sql-warehouse, experiment, serving-endpoint) via the app's
# resource config in the UI or `databricks apps update`, so app.yaml's valueFrom keys resolve.
databricks apps create groundtruth --profile "$PROFILE"    # first time only

# Deploy the synced source
databricks apps deploy groundtruth --source-code-path "$DEST" --profile "$PROFILE"
```

## 5. Verify
- App URL prints from `apps deploy` (form `https://groundtruth-<workspace-id>.aws.databricksapps.com`).
- **Schema auto-creates on startup** — `gunicorn_conf.py:on_starting` runs
  `bootstrap_database()` (`Base.metadata.create_all`) once before workers fork. The empty
  `migrations/versions/` is expected, not broken.
- Hit `/api/health`, then log in as the facilitator and create a test project.
- If DB reads fail with `relation "..." does not exist` despite tables existing, it's the
  `search_path` pooling issue — the fix (commit after `SET search_path`) is already in
  `server/db_config.py`; just confirm the deployed code matches this repo.

## What does NOT carry over
- **Runtime data** (projects / items / judgments) lives only in the previous workspace's
  Lakebase `groundtruth-db`. It is not in git — export it before the old workspace is
  terminated if you need it. A fresh deploy starts empty (no seed data).

## Local development
See `README.md` — SQLite backend + Vite dev server, no workspace resources required beyond a
profile for the LLM judge.
