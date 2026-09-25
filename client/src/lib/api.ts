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

// The response under human validation for an item: Genie's answer if present, else the first one.
// External agent responses share the item (for the comparison) but aren't the review target.
export function baselineResponse(it: Item): Response | undefined {
  return it.responses.find(r => (r.model_name || '').startsWith('genie')) ?? it.responses[0]
}

export interface JudgeCatalogItem { key: string; label: string; description: string; uses_answer_key: boolean; needs_context: boolean; is_custom: boolean }
export type GateVerdict = 'pass' | 'review' | 'fail' | 'insufficient'
export interface TrustGate { verdict: GateVerdict; reason: string; warnings?: string[] }
export type AgreementLevel = 'high' | 'moderate' | 'low' | 'n/a'
export type Calibration = 'lenient' | 'harsh' | 'balanced'

// Inter-reviewer agreement for one dimension (humans only) — answered before AI-vs-human.
export interface HumanAgreement {
  n_raters: number; n_multi_rated: number
  alpha: number | null; alpha_ci: [number | null, number | null]
  computable: boolean; level: AgreementLevel
}
// The AI judge's agreement with the human panel on the SAME dimension.
export interface AiVsHuman {
  n: number
  // binary
  n_pos?: number; n_neg?: number
  confusion?: { tp: number; fp: number; fn: number; tn: number }
  accuracy?: number | null; precision?: number | null; recall?: number | null; specificity?: number | null
  f1?: number | null; balanced_accuracy?: number | null; balanced_accuracy_ci?: [number | null, number | null]
  mcc?: number | null; cohen_kappa?: number | null
  bias?: number | null; judge_pass_rate?: number | null; human_pass_rate?: number | null
  calibration?: Calibration | null
  single_class_judge?: boolean; single_class_gold?: boolean
  // likert
  mae?: number | null; rmse?: number | null; spearman?: number | null; spearman_ci?: [number | null, number | null]
  qwk?: number | null; human_mean?: number | null; judge_mean?: number | null
}
export interface DimensionAudit {
  n_disagreements: number; n_audited: number; corrected: number; excluded: number
  full: boolean; gate_basis: 'raw' | 'adjudicated'
}
export interface DimensionCard {
  key: string; label: string
  human: HumanAgreement
  n_gold: number; has_ai_judge: boolean; small_sample: boolean
  ai_vs_human: AiVsHuman | null
  ai_vs_human_adjudicated?: AiVsHuman | null
  audit?: DimensionAudit | null
  gate: TrustGate
  audited: number
}
export interface Metrics {
  scale: Scale; level: string; small_sample_threshold: number
  n_items: number; n_responses: number; n_reviewers: number; n_dimensions: number
  primary_dimension: string | null
  answer_key_coverage: { with_key: number; total: number }
  panel_agreement_computable: boolean
  dimensions: DimensionCard[]
}
export type DisagreementCategory =
  | 'ai_incorrect' | 'human_label_incorrect' | 'ambiguous_question' | 'ambiguous_rubric'
  | 'different_interpretation' | 'insufficient_evidence' | 'other'
export interface DisagreementAudit { category: DisagreementCategory; note?: string; reviewer_id?: string }
export interface ResultsSummary { summary?: string | null; model?: string; detail?: string; fallback?: boolean; note?: string; n_gold?: number; small_sample?: boolean; at?: string | null }
// Per-agent comparison (LLM-judge scores for Genie + uploaded external agents).
export interface AgentDimScore { pass_rate?: number | null; mean?: number | null; n: number }
export interface AgentRow { model_name: string; label: string; n: number; dimensions: Record<string, AgentDimScore | null> }
export interface Comparison { scale: Scale; dimensions: { key: string; label: string }[]; agents: AgentRow[]; detail?: string }
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
  getComparison: (id: string) => req<Comparison>('GET', `/projects/${id}/comparison`),
  saveAgentLabels: (id: string, labels: Record<string, string>) =>
    req<Comparison>('PUT', `/projects/${id}/comparison/labels`, { labels }),
  resultsSummary: (id: string) => req<ResultsSummary>('POST', `/projects/${id}/results-summary`),
  getResultsSummary: (id: string) => req<ResultsSummary>('GET', `/projects/${id}/results-summary`),
  mlflowEval: (id: string) =>
    req<{ detail?: string; evaluations_url?: string; n?: number; judges?: string[] }>(
      'POST', `/projects/${id}/mlflow-eval`),
  generate: (id: string, mode: GenerationMode, grade = false, item_ids?: string[]) =>
    req<GenerateResult>('POST', `/projects/${id}/generate`, { mode, grade, item_ids }),
  generateStatus: (id: string) =>
    req<{ status: string; total?: number; generated?: number; errors?: string[]; detail?: string
          phase?: string; graded?: number; grade_total?: number }>(
      'GET', `/projects/${id}/generate/status`),
  cancelGenerate: (id: string) =>
    req<{ status: string; detail?: string }>('POST', `/projects/${id}/generate/cancel`),
  inviteMember: (projectId: string, email: string, name?: string) =>
    req<User>('POST', `/projects/${projectId}/members`, { email, name }),
  listMembers: (projectId: string) => req<User[]>('GET', `/projects/${projectId}/members`),
  listItems: (projectId: string) => req<Item[]>('GET', `/projects/${projectId}/items`),
  uploadCsv: (projectId: string, file: File, replace = false) => {
    const fd = new FormData(); fd.append('file', file); fd.append('replace', String(replace))
    return req<{ items_created: number; responses_created: number; warnings: string[]; detail?: string }>(
      'POST', `/projects/${projectId}/intake/csv`, fd, true)
  },
  submitJudgment: (responseId: string, v: { verdict?: Verdict; score?: number; rationale?: string; rater_id?: string; judge_key?: string }) =>
    req<Judgment>('POST', `/responses/${responseId}/judgment`, v),
  // Save a reviewer's verdicts across every dimension for one response, with a shared comment.
  submitJudgments: (responseId: string, body: { rater_id?: string; rationale?: string; dims: { judge_key: string; verdict?: Verdict; score?: number }[] }) =>
    req<Judgment[]>('POST', `/responses/${responseId}/judgments`, body),
  classifyDisagreement: (responseId: string, body: { judge_key: string; category: DisagreementCategory; note?: string; reviewer_id?: string }) =>
    req<{ response_id: string; judge_key: string; category: DisagreementCategory }>('POST', `/responses/${responseId}/disagreement`, body),
  listDisagreements: (projectId: string) =>
    req<Record<string, DisagreementAudit>>('GET', `/projects/${projectId}/disagreements`),
  runJudge: (projectId: string) =>
    req<{ judged: number; detail?: string; errors?: string[] }>('POST', `/projects/${projectId}/run-judge`),
}
