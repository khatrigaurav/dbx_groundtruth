# GroundTruth

A simple **answer-key evaluation** app for Databricks. Import questions with their expected
answers, collect agent responses (Genie and/or external agents), grade them with an **LLM
judge**, confirm the judge against **human reviewers**, then **compare every agent** on the
now-trusted judge.

Deliberately simpler than VibeScaler: no discovery/rubric/IRR/alignment pipeline. Just
**Project → Items (question + expected answer + responses) → Judgments (llm | human)**.

## What you can do with it

1. **Create a project** and pick a scale (binary pass/fail or 1–5 Likert) and the judge
   dimensions you care about (correctness, relevance, safety, groundedness, or a custom rubric).
2. **Load questions** from an answer sheet, Genie One, or an MLflow experiment.
3. **Generate answers** with Genie One (on-behalf-of you, or as the app service principal).
4. **Grade** every response with the LLM judge (each judge scores one dimension).
5. **Review** a sample by hand — the app measures how well the judge agrees with the panel
   (Krippendorff's α, precision/recall/F1/κ, a readiness gate) so you know if the judge is
   trustworthy.
6. **Compare agents** — once the judge is trusted, it scores *every* agent's answers so you can
   line them up head-to-head per dimension. See [Comparison analysis](#comparison-analysis).

## Stack
- Backend: FastAPI + SQLAlchemy (SQLite local, Lakebase Postgres in prod)
- Frontend: React + Vite + Tailwind (built to `client/dist`, served by FastAPI)
- Judge: Databricks serving endpoint (`SERVING_ENDPOINT`, default `databricks-claude-sonnet-5`)

> **Migrating this to your own workspace?** See **[AGENTS.md](AGENTS.md)** — point your coding
> agent at it and it has the step-by-step to redeploy into a fresh workspace.

## Deployment

Deploy to **any Databricks workspace** as a Databricks App via the **Asset Bundle**
(`databricks.yml`). One command builds the frontend, creates the resources, and deploys.

### 0. Prerequisites
- Databricks CLI **v0.265.0+** (`database_instances` support).
  - `brew install databricks/tap/databricks`
  - Check: `databricks --version`.
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

The `dev` target is  local ; the `<project_target_name>` target is the handover slot — rename
it to your project, fill in your own `warehouse_id`, and deploy with your own profile.

### 2. Deploy the bundle (builds the frontend for you)

```bash
PROFILE=<your-profile>          # supplies the workspace host — nothing hardcoded
TARGET=<project_target_name>    # the target you set above, or `dev`

databricks bundle validate -t "$TARGET" -p "$PROFILE"   # sanity check
databricks bundle deploy   -t "$TARGET" -p "$PROFILE"    # builds + creates resources + deploys
```

That single `deploy` will:
1. **Build the React SPA** — the `artifacts.frontend` step runs `npm ci && npm run build` in
   `client/` before syncing, so `client/dist` is always current. No manual npm step, and no
   stale-build drift.
2. Create the Lakebase instance `groundtruth-db` and the MLflow experiment `/Shared/groundtruth-intake`.
3. Sync the source to `${workspace.file_path}`.
4. Create/update the app `groundtruth`, attaching `database`, `sql-warehouse`,
   `serving-endpoint`, and `experiment` — so the app's `value_from` keys and injected
   `PGHOST/PGUSER/PGPORT/PGDATABASE` all resolve automatically.

### 3. Verify
- App URL: `databricks apps get groundtruth -p "$PROFILE"` (form `https://groundtruth-<workspace-id>.aws.databricksapps.com`).
- Hit `/api/health`, then log in as the facilitator and create a test project.

### Config sources (where things live)
- `databricks.yml` — **authoritative** for the app command + all env vars + resource
  creation and bindings. Edit workspace-specific values here (in `targets`).
- `app.yaml` — a minimal local-dev stub (start command only). The bundle `config` overrides
  it on deploy; it exists only so a bare `databricks apps deploy` still launches.

## Data sources (intake)

Three ways to get questions and responses into a project. All of them create **Items**
(question + optional expected answer) and, where present, **Responses** (one per agent).

### 1. Answer sheet (pipe-delimited)
A `|`-separated file — pipe (not comma) so questions, answers, and responses can contain
commas freely without quoting. Accepts `.csv` / `.txt` / `.psv`. Column headers are
**case-insensitive** and matched by role:

| Role | Accepted column names | Notes |
|---|---|---|
| **Question** (required) | `question`, `request`, `input` | One Item per row. |
| **Expected answer** | `expected_answer`, `expected`, `answer`, `ground_truth` | Optional — but the **correctness** and **custom/guidelines** judges score against it. Rows with no expected answer are **skipped by those judges** (other dimensions still score). |
| **Single response** | `response`, `response_preview`, `output` | Optional. Paired with `model` / `model_name` for its label (defaults to `response`). |
| **External-agent responses** | *any other column* | **This is how you set up a comparison.** Each extra column is treated as one agent's answer; its header becomes the agent name (a `_response` / `_answer` / `_output` / `_reply` suffix is stripped, so `agent1_response` → `agent1`). Every non-empty cell becomes a Response for that agent. |

**Minimal example** — just questions and an answer key:

| question | expected_answer |
|---|---|
| What is the capital of France? | Paris |
| Which planet is known as the Red Planet? | Mars |

**Comparison example** — extra columns become agents scored side-by-side (Genie answers are
added later by the Genie step and compared against these):

```
question|expected_answer|agent1_response|agent2_response
What is the capital of France?|Paris|Paris is the capital.|The capital is Paris, France.
What is 2 + 2?|4|4|It's 4.
```

A sample file is checked in: `sample_eval_v2.csv`.

### 2. Genie One (MCP)
One question per line; optional answer key as `question | expected`. Runs each through the
workspace Genie MCP server and synthesizes a grounded answer, stored as the **`genie`** agent
(the review baseline). Two modes:
- **Run as me (OBO)** — conversations appear in *your* Genie One history and use *your* data
  grants (requires user authorization forwarded to the app).
- **Background (service principal)** — runs as the app SP; does not surface in Genie One. The
  app SP needs SELECT on the queried Unity Catalog data.

### 3. MLflow experiment
Enter an experiment id + max traces; imports each trace's request → Item and response → Response.

## Comparison analysis

The payoff of validating the judge. Once you've confirmed (on the Results page) that the LLM
judge agrees well enough with your human panel for a dimension, that judge is trusted — so it
can score **every** agent's answers, not just Genie's, and you can rank them.

- **Where:** the **Compare results** step on the project page → **Run comparison analysis**
  (`/projects/:id/compare`, facilitators only).
- **What it shows:** a per-agent × per-dimension scorecard — **pass rate** (binary) or **mean
  score** (Likert) — for every response source in the project: Genie plus each external agent
  you uploaded via extra answer-sheet columns. Grouped bar charts visualize the same numbers,
  the leading agent in each dimension is highlighted, and you can give each agent a friendly
  display name (saved on the project). Genie is always listed first.
- **What it uses:** **only the LLM-judge verdicts** — no human panel — so it reflects the
  trusted judge scoring everyone the same way. (The Results page stays focused on Genie +
  judge validation; Compare is the head-to-head view.)

To set up a comparison: upload an answer sheet with one extra column per agent (see the
[comparison example](#1-answer-sheet-pipe-delimited) above), generate Genie's answers, grade
with the AI judge, then open Compare.

## Local development (optional)

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
**Reviewers** are invited by email to a project (recorded against their real SSO email for
attribution), but membership is no longer an access gate. Human verdicts are attributed to the
caller resolved **server-side** from the SSO identity, so a reviewer's own scores re-hydrate
even if the local session id has changed.

## Status
- [x] Phase 0 — scaffold, dual-mode auth, schema bootstrap, health
- [x] Phase 1 — answer-sheet import, human review loop, results + agreement
- [x] Phase 2 — LLM judge (`POST /api/projects/{id}/run-judge`), per-dimension validation
- [x] Phase 3 — Genie One MCP question-runner + MLflow experiment-ID intake
- [x] Comparison — per-agent scorecard + grouped bar charts on the validated judge
- [x] Deploy — Databricks Asset Bundle (`databricks.yml`): one `databricks bundle deploy`
      creates the Lakebase instance + MLflow experiment, binds resources, and deploys the
      app. No workspace hardcoded — host from the CLI profile, per-workspace values are
      bundle variables. See **Deployment** above and **[AGENTS.md](AGENTS.md)**.
- [ ] Phase 4 — facilitator progress view, seed demo data
