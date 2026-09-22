// Minimal API client + session (v1 token = user id, stored in localStorage).

export type Role = 'facilitator' | 'tester'
export interface User { id: string; email: string; name?: string; role: Role }
export type Scale = 'binary' | 'likert'
export type GenerationMode = 'user' | 'sp'
export interface ProjectJudge { judge_key: string; enabled: boolean; instructions?: string; model?: string }
export interface Project {
  id: string; name: string; description?: string; item_count: number
  scale: Scale
  mlflow_experiment_id?: string
  experiment_url?: string
  genie_url?: string
  genie_last_run_mode?: GenerationMode
  judges: ProjectJudge[]
  judge_instructions?: string; judge_model?: string
  blind_review: boolean
}
export type Verdict = 'pass' | 'fail'
export interface Judgment { id: string; kind: 'llm' | 'human'; rater_id?: string; judge_key?: string; verdict?: Verdict; score?: number; rationale?: string }
export interface Response { id: string; response_text: string; model_name?: string; mlflow_trace_id?: string; judgments: Judgment[] }
export interface Item { id: string; question: string; expected_answer?: string; source: string; responses: Response[] }

export interface JudgeCatalogItem { key: string; label: string; description: string; uses_answer_key: boolean; needs_context: boolean; is_custom: boolean }
export interface PerRater { rater: string; label: string; kind: 'llm' | 'human'; n: number; mean?: number; pass_rate?: number }
export type GateVerdict = 'pass' | 'review' | 'fail' | 'insufficient'
export interface TrustGate { verdict: GateVerdict; reason: string }
export interface JudgeScorecard {
  judge_key: string; label: string; n: number; gate: TrustGate; bias: number | null
  // binary
  confusion?: { tp: number; fp: number; fn: number; tn: number }
  accuracy?: number | null; precision?: number | null; recall?: number | null
  specificity?: number | null; f1?: number | null; f1_ci?: [number | null, number | null]
  balanced_accuracy?: number | null; mcc?: number | null; cohen_kappa?: number | null
  // likert
  spearman?: number | null; spearman_ci?: [number | null, number | null]; qwk?: number | null
  mae?: number | null; rmse?: number | null; human_mean?: number | null; judge_mean?: number | null
}
export interface Metrics {
  scale: Scale; level: string
  n_items: number; n_responses: number; n_gold: number; n_reviewers: number; n_judges: number
  n_units_multi_rated: number; small_sample: boolean
  answer_key_coverage: { with_key: number; total: number }
  alpha_all: number | null; alpha_all_ci: [number | null, number | null]
  alpha_humans: number | null; alpha_humans_ci: [number | null, number | null]
  human_pass_rate: number | null; human_mean: number | null
  per_rater: PerRater[]; judges: JudgeScorecard[]; primary_judge: string | null
}
export interface ResultsSummary { summary?: string; model?: string; detail?: string; n_gold?: number; small_sample?: boolean }
export interface GenerateResult {
  mode: GenerationMode; generated: number; run_id?: string; run_url?: string
  genie_url?: string; experiment_id?: string; experiment_url?: string
  surfaces_in_genie_ui: boolean; errors: string[]; detail?: string
}

const SESSION_KEY = 'groundtruth.session'

export function getSession(): User | null {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null } catch { return null }
}
export function setSession(u: User | null) {
  try { u ? localStorage.setItem(SESSION_KEY, JSON.stringify(u)) : localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

async function req<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {}
  const u = getSession()
  if (u) headers['X-User-Id'] = u.id
  let payload: BodyInit | undefined
  if (isForm) { payload = body as FormData }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`/api${path}`, { method, headers, body: payload })
  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail ?? detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  // Identity comes from Databricks Apps SSO (forwarded headers) — no credentials sent.
  // `projects` is the scoped review assignments for a reviewer (empty for facilitators).
  whoami: () => req<{ user: User; token: string; projects: { id: string; name: string }[] }>('GET', '/auth/whoami'),
  listProjects: () => req<Project[]>('GET', '/projects'),
  createProject: (name: string, scale: Scale, description?: string) =>
    req<Project>('POST', '/projects', { name, scale, description }),
  getProject: (id: string) => req<Project>('GET', `/projects/${id}`),
  deleteProject: (id: string) =>
    req<{ deleted: string; experiment_deleted: boolean; detail?: string }>('DELETE', `/projects/${id}`),
  setJudgeConfig: (id: string, judges: ProjectJudge[]) =>
    req<Project>('PUT', `/projects/${id}/judge-config`, { judges }),
  setBlindReview: (id: string, enabled: boolean) =>
    req<Project>('PUT', `/projects/${id}/blind-review`, { enabled }),
  judgeCatalog: () => req<{ judges: JudgeCatalogItem[]; models: string[] }>('GET', '/judge-catalog'),
  getMetrics: (id: string) => req<Metrics>('GET', `/projects/${id}/metrics`),
  resultsSummary: (id: string) => req<ResultsSummary>('POST', `/projects/${id}/results-summary`),
  generate: (id: string, mode: GenerationMode, item_ids?: string[]) =>
    req<GenerateResult>('POST', `/projects/${id}/generate`, { mode, item_ids }),
  generateStatus: (id: string) =>
    req<{ status: string; total?: number; generated?: number; errors?: string[]; detail?: string }>(
      'GET', `/projects/${id}/generate/status`),
  cancelGenerate: (id: string) =>
    req<{ status: string; detail?: string }>('POST', `/projects/${id}/generate/cancel`),
  inviteMember: (projectId: string, email: string, name?: string) =>
    req<User>('POST', `/projects/${projectId}/members`, { email, name }),
  listMembers: (projectId: string) => req<User[]>('GET', `/projects/${projectId}/members`),
  listItems: (projectId: string) => req<Item[]>('GET', `/projects/${projectId}/items`),
  uploadCsv: (projectId: string, file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return req<{ items_created: number; responses_created: number; warnings: string[]; detail?: string }>(
      'POST', `/projects/${projectId}/intake/csv`, fd, true)
  },
  submitJudgment: (responseId: string, v: { verdict?: Verdict; score?: number; rationale?: string; rater_id?: string }) =>
    req<Judgment>('POST', `/responses/${responseId}/judgment`, v),
  runJudge: (projectId: string) =>
    req<{ judged: number; detail?: string; errors?: string[] }>('POST', `/projects/${projectId}/run-judge`),
}
