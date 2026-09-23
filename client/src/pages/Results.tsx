import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowLeft, Info, Sparkles, RefreshCw, Users, Bot, Key,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Layers,
  ChevronDown, ChevronUp, ExternalLink, FlaskConical,
} from 'lucide-react'
import {
  api, type AiVsHuman, type DimensionCard as DimCard, type DisagreementAudit,
  type DisagreementCategory, type HumanAgreement as HumanAgreementT,
  type Item, type Metrics, type Project, type User, type Verdict,
} from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Markdown } from '../components/Markdown'
import { cn } from '../lib/utils'
import { cacheGet, cacheKey, cacheSet } from '../lib/cache'

type V = Verdict | undefined
const majority = (vs: V[]): V => {
  const f = vs.filter(Boolean) as Verdict[]
  if (!f.length) return undefined
  return f.filter(v => v === 'pass').length * 2 >= f.length ? 'pass' : 'fail'
}

const fmt = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2))
const ciText = (ci?: [number | null, number | null]) =>
  ci && ci[0] != null && ci[1] != null ? `95% CI ${ci[0].toFixed(2)}–${ci[1].toFixed(2)}` : undefined

const DISAGREEMENT_CATS: [DisagreementCategory, string][] = [
  ['ai_incorrect', 'AI judge incorrect'],
  ['human_label_incorrect', 'Human label incorrect'],
  ['ambiguous_question', 'Ambiguous question'],
  ['ambiguous_rubric', 'Ambiguous rubric'],
  ['different_interpretation', 'Different reasonable interpretation'],
  ['insufficient_evidence', 'Insufficient evidence'],
  ['other', 'Other'],
]

// --- trust gate + agreement styling -----------------------------------------
const GATE = {
  pass: { label: 'Trusted', cls: 'bg-success text-success-foreground', Icon: CheckCircle2 },
  review: { label: 'Spot-check', cls: 'bg-amber-500 text-white', Icon: AlertTriangle },
  fail: { label: 'Not ready', cls: 'bg-destructive text-destructive-foreground', Icon: XCircle },
  insufficient: { label: 'Need data', cls: 'bg-muted text-muted-foreground', Icon: HelpCircle },
} as const

const AGREE = {
  high: 'bg-success/15 text-success border-success/30',
  moderate: 'bg-amber-100 text-amber-800 border-amber-300',
  low: 'bg-destructive/10 text-destructive border-destructive/30',
  'n/a': 'bg-muted text-muted-foreground border-transparent',
} as const

function GateBadge({ verdict, hint }: { verdict: keyof typeof GATE; hint?: string }) {
  const g = GATE[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', g.cls)}>
      <g.Icon className="h-3.5 w-3.5" /> {g.label}
      {hint && <Tip text={hint} />}
    </span>
  )
}

// Context-aware "what to do next" for the gate badge tooltip.
function nextStep(card: DimCard): string {
  const v = card.gate.verdict
  const a = card.ai_vs_human
  if (v === 'insufficient') {
    if (!card.has_ai_judge) return 'Next: enable an AI judge for this dimension in “Build AI judges”, then grade.'
    if (a?.single_class_gold || (a && (a.n_neg === 0 || a.n_pos === 0)))
      return 'Next: humans labeled only one class here — add clear examples of the missing class (both a pass and a fail), then re-review.'
    return `Next: only ${card.n_gold} gold-labeled item(s). Have reviewers grade more on this dimension (aim ≥15, with both pass and fail), then reopen Results.`
  }
  if (v === 'fail') {
    if (a?.single_class_judge) return 'Next: the judge predicts one class for everything — tighten its rubric in “Build AI judges” and re-grade.'
    if (card.human.computable && card.human.level === 'low')
      return 'Next: reviewers barely agree here, so the rubric is ambiguous — fix the rubric/answer key and re-review before blaming the judge.'
    return 'Next: don’t rely on this judge. Audit its disagreements below, refine its rubric, and re-grade — or fix ambiguous gold labels.'
  }
  if (v === 'review') return 'Next: usable with human spot-checks — audit the disagreements below before trusting it unattended.'
  return 'Trustworthy on this dimension — keep periodic spot-checks.'
}

// Hover/focus tooltip — an info dot that reveals what a metric measures. No extra deps.
function Tip({ text }: { text: string }) {
  return (
    <span className="group/tip relative inline-flex align-middle">
      <Info tabIndex={0} className="h-3 w-3 cursor-help text-muted-foreground/60 outline-none hover:text-muted-foreground focus:text-muted-foreground" />
      <span role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-56 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-background shadow-lg group-hover/tip:block group-focus-within/tip:block">
        {text}
      </span>
    </span>
  )
}

function VerdictCell({ v, s }: { v?: V; s?: number }) {
  if (s != null) return <Badge variant={s >= 3 ? 'success' : 'destructive'}>{s}</Badge>
  if (!v) return <Badge variant="muted">—</Badge>
  return <Badge variant={v === 'pass' ? 'success' : 'destructive'} className="capitalize">{v}</Badge>
}

function Metric({ label, value, sub, hint, big }: { label: string; value: string; sub?: string; hint?: string; big?: boolean }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}{hint && <Tip text={hint} />}
      </div>
      <div className={cn('mt-0.5 font-semibold tabular-nums', big ? 'text-2xl' : 'text-lg')}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function Confusion({ c }: { c: { tp: number; fp: number; fn: number; tn: number } }) {
  const Cell = ({ n, label, good }: { n: number; label: string; good: boolean }) => (
    <div className={cn('rounded-md px-2 py-1.5 text-center', good ? 'bg-success/10' : 'bg-destructive/10')}>
      <div className="text-base font-semibold tabular-nums">{n}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  )
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Confusion vs human panel</div>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-1 text-[10px]">
        <div />
        <div className="text-center text-muted-foreground">human pass</div>
        <div className="text-center text-muted-foreground">human fail</div>
        <div className="text-muted-foreground [writing-mode:vertical-lr]">judge pass</div>
        <Cell n={c.tp} label="true pos" good />
        <Cell n={c.fp} label="false pos" good={false} />
        <div className="text-muted-foreground [writing-mode:vertical-lr]">judge fail</div>
        <Cell n={c.fn} label="false neg" good={false} />
        <Cell n={c.tn} label="true neg" good />
      </div>
    </div>
  )
}

function CalibrationChip({ cal, bias, scale }: { cal?: string | null; bias?: number | null; scale: string }) {
  if (!cal) return null
  const b = bias == null ? '' : ` (${bias >= 0 ? '+' : ''}${bias.toFixed(2)}${scale === 'likert' ? ' pts' : ''} vs humans)`
  const cls = cal === 'lenient' ? 'text-amber-600' : cal === 'harsh' ? 'text-sky-600' : 'text-muted-foreground'
  return (
    <span className={cn('text-xs font-medium', cls)}>
      Calibration: {cal}{b}
      <Tip text="Systematic leniency/harshness — how much more (or less) often the judge passes vs the human panel. Reported separately from agreement: a judge can agree yet still be biased." />
    </span>
  )
}

// Answer #1: do humans agree on the rubric? Shown before any AI-vs-human number.
function HumanAgreementStrip({ h }: { h: HumanAgreementT }) {
  if (h.n_raters < 2) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Users className="mr-1 inline h-3.5 w-3.5" />
        {h.n_raters === 0 ? 'No human reviews on this dimension yet.'
          : 'Single reviewer — panel agreement can’t be measured. Add a 2nd reviewer to check the rubric before trusting the judge.'}
      </div>
    )
  }
  const level = h.level as keyof typeof AGREE
  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs', AGREE[level])}>
      <Users className="h-3.5 w-3.5" />
      <span className="font-semibold">Reviewer agreement: {level}</span>
      <span className="tabular-nums">α {fmt(h.alpha)}{ciText(h.alpha_ci) ? ` · ${ciText(h.alpha_ci)}` : ''}</span>
      <span className="text-current/70">· {h.n_raters} reviewers, {h.n_multi_rated} co-rated</span>
      <Tip text="Inter-reviewer Krippendorff's α for this dimension only. Answered first: if reviewers don't agree, the rubric is ambiguous and low AI agreement is not proof the judge is bad." />
      {level === 'low' && <span className="font-medium">— ambiguous rubric; audit gold labels first.</span>}
    </div>
  )
}

function AiVsHumanBinary({ a }: { a: AiVsHuman }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">{a.n_pos ?? 0} human pass</span>
        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{a.n_neg ?? 0} human fail</span>
        {a.confusion && <span>· {a.confusion.fp} false-pos, {a.confusion.fn} false-neg</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric big label="Balanced acc." value={fmt(a.balanced_accuracy)} sub={ciText(a.balanced_accuracy_ci)}
          hint="Average of recall and specificity — the headline metric under class imbalance (accuracy alone is misleading when most labels are one class)." />
        <Metric label="MCC" value={fmt(a.mcc)}
          hint="Matthews correlation — robust to class imbalance. −1 to +1; >0.5 strong." />
        <Metric label="Cohen's κ" value={fmt(a.cohen_kappa)}
          hint="Chance-corrected agreement with the human panel. ≥0.6 substantial, ≥0.8 near-perfect." />
        <Metric label="F1" value={fmt(a.f1)}
          hint="Harmonic mean of precision and recall. Can look high even when specificity is 0 — read it alongside balanced accuracy." />
        <Metric label="Precision" value={fmt(a.precision)} hint="Of items the judge passed, how many humans also passed." />
        <Metric label="Recall" value={fmt(a.recall)} hint="Of items humans passed, how many the judge also passed." />
        <Metric label="Specificity" value={fmt(a.specificity)} hint="Of items humans FAILED, how many the judge also failed — its ability to catch failures." />
        <Metric label="Accuracy" value={fmt(a.accuracy)} hint="Raw share of agreeing items. Inflated under class imbalance — don't read alone." />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
        {a.confusion && <Confusion c={a.confusion} />}
        <div className="sm:pl-2"><CalibrationChip cal={a.calibration} bias={a.bias} scale="binary" /></div>
      </div>
    </>
  )
}

function AiVsHumanLikert({ a }: { a: AiVsHuman }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric big label="Spearman ρ" value={fmt(a.spearman)} sub={ciText(a.spearman_ci)}
          hint="Rank correlation between judge and human scores. 1 = identical ordering." />
        <Metric label="QWK" value={fmt(a.qwk)} hint="Quadratic weighted kappa — the standard ordinal-agreement metric for graded scoring." />
        <Metric label="MAE" value={fmt(a.mae)} hint="Mean absolute error between judge and human scores (points on 1–5)." />
        <Metric label="RMSE" value={fmt(a.rmse)} hint="Root-mean-square error — penalizes large misses more than MAE." />
        <Metric label="Judge mean" value={fmt(a.judge_mean)} hint="Average score this judge gave." />
        <Metric label="Human mean" value={fmt(a.human_mean)} hint="Average score the human panel gave on the same items." />
      </div>
      <CalibrationChip cal={a.calibration} bias={a.bias} scale="likert" />
    </>
  )
}

// Shows how the gold-label audit moves the headline metric and whether it's driving the verdict.
function AdjudicationStrip({ card, isLikert }: { card: DimCard; isLikert: boolean }) {
  const au = card.audit
  const raw = card.ai_vs_human
  const adj = card.ai_vs_human_adjudicated
  if (!au || au.n_disagreements === 0 || !raw) return null
  const rawV = isLikert ? raw.spearman : raw.balanced_accuracy
  const adjV = adj ? (isLikert ? adj.spearman : adj.balanced_accuracy) : null
  const label = isLikert ? 'Spearman ρ' : 'Balanced acc.'
  const changed = au.corrected + au.excluded > 0
  const remaining = au.n_disagreements - au.n_audited
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <div className="font-semibold text-foreground">Gold-label audit</div>
      <div className="mt-0.5">
        {au.n_audited}/{au.n_disagreements} disagreements classified · {au.corrected} gold-label correction(s), {au.excluded} excluded.
      </div>
      {changed && (
        <div className="mt-0.5">{label} <span className="tabular-nums">{fmt(rawV)}</span> → <span className="font-semibold tabular-nums">{fmt(adjV)}</span> after adjudication.</div>
      )}
      <div className="mt-0.5">
        {au.gate_basis === 'adjudicated'
          ? <span className="font-medium text-success">✓ Verdict uses adjudicated labels.</span>
          : remaining > 0
            ? <span>Classify the remaining {remaining} disagreement(s) to apply the audit to the verdict.</span>
            : <span>No gold-label corrections needed — verdict unchanged.</span>}
      </div>
    </div>
  )
}

function DimensionCard({ card, scale, primary }: { card: DimCard; scale: string; primary: boolean }) {
  const isLikert = scale === 'likert'
  const a = card.ai_vs_human
  const warnings = card.gate.warnings || []
  return (
    <Card className={cn('flex flex-col', primary && 'ring-2 ring-primary/30')}>
      <CardContent className="flex flex-1 flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">AI {card.label.toLowerCase()} vs human {card.label.toLowerCase()}</span>
            {card.key === 'custom' && (
              <span className="inline-flex items-center rounded-full bg-violet-500 px-2.5 py-1 text-xs font-semibold text-white">Custom</span>
            )}
            {primary && <Badge variant="secondary" className="text-[10px]">primary</Badge>}
          </div>
          <GateBadge verdict={card.gate.verdict} hint={nextStep(card)} />
        </div>

        {/* 1. Do humans agree on the rubric? (always shown first) */}
        <HumanAgreementStrip h={card.human} />

        {/* 2. Does the AI agree with the panel? */}
        <p className="text-xs text-muted-foreground">{card.gate.reason}</p>

        {!card.has_ai_judge ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
            No AI judge is configured for this dimension — reviewers scored it, but there's no judge to validate.
          </div>
        ) : !a || card.n_gold === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
            No overlapping human + AI labels yet. Grade this dimension to unlock its scorecard.
          </div>
        ) : isLikert ? <AiVsHumanLikert a={a} /> : <AiVsHumanBinary a={a} />}

        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{w}
              </li>
            ))}
          </ul>
        )}

        {a && <AdjudicationStrip card={card} isLikert={isLikert} />}

        <div className="mt-auto text-[11px] text-muted-foreground">
          Scored on {a?.n ?? card.n_gold} human-graded item(s).
        </div>
      </CardContent>
    </Card>
  )
}

// Shown while the (heavier) metrics call is in flight on a cold load, so the body isn't blank.
function CardsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1].map(i => (
        <Card key={i}><CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="h-8 animate-pulse rounded bg-muted" />
          <div className="grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map(j => <div key={j} className="h-14 animate-pulse rounded bg-muted" />)}
          </div>
        </CardContent></Card>
      ))}
    </div>
  )
}

function Overview({ m }: { m: Metrics }) {
  const cov = m.answer_key_coverage
  const tiles = [
    { icon: Layers, label: 'Dimensions', value: `${m.n_dimensions}`, sub: m.dimensions.map(d => d.label).join(', ') || 'none',
      hint: 'Each enabled AI judge is validated against the human panel for the SAME dimension — never against a single generic verdict.' },
    { icon: Users, label: 'Reviewers', value: `${m.n_reviewers}`, sub: m.panel_agreement_computable ? 'panel agreement measurable' : 'need ≥2 for panel agreement',
      hint: 'Human reviewers. With ≥2 we can measure whether they agree on each rubric (shown per dimension). A single reviewer can’t produce a panel-agreement statistic.' },
    { icon: Bot, label: 'Responses', value: `${m.n_responses}`, sub: `${m.n_items} questions`,
      hint: 'Generated answers under evaluation, across all questions.' },
    { icon: Key, label: 'Answer-key coverage', value: cov.total ? `${Math.round((cov.with_key / cov.total) * 100)}%` : '—', sub: `${cov.with_key}/${cov.total} items`,
      hint: 'Share of questions with an expected answer. Correctness judging applies to these.' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map(t => (
        <Card key={t.label}><CardContent className="py-4">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <t.icon className="h-3.5 w-3.5" /> {t.label} <Tip text={t.hint} />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</div>
          <div className="truncate text-xs text-muted-foreground" title={t.sub}>{t.sub}</div>
        </CardContent></Card>
      ))}
    </div>
  )
}

function SummaryPanel({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(true)   // expanded by default once a summary exists
  const generate = async () => {
    setLoading(true); setErr(null); setNote(null)
    try {
      const r = await api.resultsSummary(id)
      if (r.summary) { setText(r.summary); setNote(r.fallback ? (r.note || 'Computed read (LLM unavailable).') : null); setOpen(true) }
      else { setText(null); setErr(r.detail || 'No summary returned.') }
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  return (
    <Card className="border-primary/30 bg-accent/40">
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> AI summary
          </div>
          <div className="flex items-center gap-2">
            {text && (
              <Button size="sm" variant="ghost" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                {open ? <><ChevronUp className="h-4 w-4" /> Hide</> : <><ChevronDown className="h-4 w-4" /> Show</>}
              </Button>
            )}
            <Button size="sm" variant={text ? 'outline' : 'default'} onClick={generate} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {loading ? 'Analyzing…' : text ? 'Regenerate' : 'Summarize results'}
            </Button>
          </div>
        </div>

        {err && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        {text && open && (
          <div className="mt-3">
            {note && <p className="mb-2 text-[11px] italic text-muted-foreground">{note}</p>}
            <Markdown>{text}</Markdown>
          </div>
        )}
        {text && !open && (
          <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs text-primary hover:underline">
            Summary hidden — click Show to expand.
          </button>
        )}
        {!text && !err && (
          <p className="mt-2 text-sm text-muted-foreground">
            Get a plain-English, per-dimension read of whether your judges can be trusted, where they're biased, and what to do next.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function Results() {
  const { id = '' } = useParams()
  // Seed from the session cache (warmed by the project page) so Results paints instantly.
  const [project, setProject] = useState<Project | null>(() => cacheGet<Project>(cacheKey('project', id)) ?? null)
  const [items, setItems] = useState<Item[]>(() => cacheGet<Item[]>(cacheKey('items', id)) ?? [])
  const [members, setMembers] = useState<User[]>(() => cacheGet<User[]>(cacheKey('members', id)) ?? [])
  const [metrics, setMetrics] = useState<Metrics | null>(() => cacheGet<Metrics>(cacheKey('metrics', id)) ?? null)
  const [metricsLoaded, setMetricsLoaded] = useState<boolean>(() => cacheGet<Metrics>(cacheKey('metrics', id)) !== undefined)
  const [audits, setAudits] = useState<Record<string, DisagreementAudit>>(() => cacheGet<Record<string, DisagreementAudit>>(cacheKey('audits', id)) ?? {})
  const [dimTab, setDimTab] = useState<string>('')
  const [filter, setFilter] = useState<'all' | 'disagree'>('all')

  const reload = () => {
    api.getProject(id).then(v => setProject(cacheSet(cacheKey('project', id), v))).catch(() => {})
    api.listItems(id).then(v => setItems(cacheSet(cacheKey('items', id), v))).catch(() => {})
    api.listMembers(id).then(v => setMembers(cacheSet(cacheKey('members', id), v))).catch(() => {})
    api.getMetrics(id).then(v => { setMetrics(cacheSet(cacheKey('metrics', id), v)); setMetricsLoaded(true) }).catch(() => setMetricsLoaded(true))
    api.listDisagreements(id).then(v => setAudits(cacheSet(cacheKey('audits', id), v))).catch(() => {})
  }
  useEffect(reload, [id])

  const isLikert = project?.scale === 'likert'
  const emailOf = useMemo(() => Object.fromEntries(members.map(m => [m.id, m.email])), [members])
  const dims = metrics?.dimensions ?? []
  const primaryDim = metrics?.primary_dimension ?? null
  const activeDim = dimTab || primaryDim || dims[0]?.key || ''

  // Per-item diagnostics for the ACTIVE dimension: human panel vs AI, with a disagreement audit.
  const rows = useMemo(() => items.map(it => {
    const r = it.responses[0]
    const js = r?.judgments ?? []
    const humanMatch = (jk?: string) => jk === activeDim || (!jk && activeDim === primaryDim)
    const humanVs = js.filter(j => j.kind === 'human' && humanMatch(j.judge_key) && (j.verdict || j.score != null))
    const panelBin = majority(humanVs.map(j => j.verdict as V))
    const panelMean = humanVs.length ? humanVs.reduce((s, j) => s + (j.score ?? (j.verdict === 'pass' ? 5 : 1)), 0) / humanVs.length : undefined
    const aiJ = js.find(j => j.kind === 'llm' && j.judge_key === activeDim)
    const ai = aiJ?.verdict as V
    const aiScore = aiJ?.score ?? undefined
    const disagree = isLikert
      ? panelMean != null && aiScore != null && Math.abs(panelMean - aiScore) >= 2
      : !!(ai && panelBin && ai !== panelBin)
    return { it, r, humanVs, panelBin, panelMean, ai, aiScore, aiRationale: aiJ?.rationale, disagree }
  }), [items, activeDim, primaryDim, isLikert])

  const shown = rows.filter(x => filter === 'all' ? true : x.disagree)
  const labelFor = (rid?: string) => (rid && emailOf[rid] || 'reviewer').split('@')[0]

  const [evalBusy, setEvalBusy] = useState(false)
  const runMlflowEval = async () => {
    setEvalBusy(true)
    const t = toast.loading('Logging MLflow evaluation run…')
    try {
      const r = await api.mlflowEval(id)
      toast.success(r.detail || 'Evaluation run logged', { id: t })
    } catch (e) { toast.error((e as Error).message, { id: t }) }
    finally { setEvalBusy(false) }
  }

  async function audit(responseId: string, category: DisagreementCategory) {
    const kk = `${responseId}:${activeDim}`
    setAudits(a => ({ ...a, [kk]: { ...a[kk], category } }))  // optimistic
    try {
      await api.classifyDisagreement(responseId, { judge_key: activeDim, category })
      toast.success(`Marked: ${DISAGREEMENT_CATS.find(c => c[0] === category)?.[1] ?? category}`)
      api.getMetrics(id).then(v => setMetrics(cacheSet(cacheKey('metrics', id), v))).catch(() => {})  // refresh gate + audited count
    } catch (e) { toast.error((e as Error).message) }
  }

  // Audit progress for the active dimension — makes the classification visibly add up to
  // something (e.g. "how many disagreements are actually bad gold labels vs AI errors").
  const auditSummary = useMemo(() => {
    const counts: Record<string, number> = {}
    const suffix = `:${activeDim}`
    for (const [k, v] of Object.entries(audits)) {
      if (k.endsWith(suffix) && v?.category) counts[v.category] = (counts[v.category] || 0) + 1
    }
    return counts
  }, [audits, activeDim])
  const totalDisagree = rows.filter(x => x.disagree).length
  const totalAudited = Object.values(auditSummary).reduce((s, n) => s + n, 0)

  const anySmall = dims.some(d => d.small_sample && d.has_ai_judge)

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Results</h1>
          {project && <Badge variant="secondary">{isLikert ? 'Likert (1–5)' : 'Binary'}</Badge>}
          <span className="text-sm text-muted-foreground">— each AI judge vs the human panel, per dimension</span>
          <div className="ml-auto flex items-center gap-3">
            {project && (
              <Button size="sm" variant="outline" onClick={runMlflowEval} disabled={evalBusy}
                title="Log an MLflow Evaluation Run from the stored verdicts (replay — no re-grading), so results show in the Evaluations tab">
                <FlaskConical className="h-4 w-4" /> {evalBusy ? 'Logging…' : 'Run MLflow evaluation'}
              </Button>
            )}
            {project?.experiment_url && (
              <a href={project.experiment_url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                title="Open the project's MLflow experiment — traces and the Evaluations tab">
                <ExternalLink className="h-3.5 w-3.5" /> Validate in MLflow
              </a>
            )}
          </div>
        </div>
      </div>

      <SummaryPanel id={id} />

      {metrics && <Overview m={metrics} />}

      {anySmall && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Small sample on one or more dimensions — metrics are noisy. Weight the confidence intervals, and expand the eval set with clear passes, clear failures, and borderline cases before trusting a verdict.
          </CardContent>
        </Card>
      )}

      {/* Per-dimension trust scorecards */}
      {!metricsLoaded && dims.length === 0 ? (
        <CardsSkeleton />
      ) : dims.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {dims.map(card => (
            <DimensionCard key={card.key} card={card} scale={metrics!.scale} primary={card.key === primaryDim} />
          ))}
        </div>
      ) : (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          {metrics?.n_reviewers === 0
            ? 'No human reviews yet — judges can’t be validated until reviewers grade a sample.'
            : 'No judges configured yet. Build AI judges on the project page, then grade.'}
        </CardContent></Card>
      )}

      {/* Per-item diagnostics + gold-label audit, for one dimension at a time */}
      {dims.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Per-item diagnostics & gold-label audit</h2>
            <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
              <TabsList>
                <TabsTrigger value="all">All ({rows.length})</TabsTrigger>
                <TabsTrigger value="disagree">Disagreements ({rows.filter(x => x.disagree).length})</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Tabs value={activeDim} onValueChange={setDimTab}>
            <TabsList>
              {dims.map(d => <TabsTrigger key={d.key} value={d.key}>{d.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            Showing the <span className="font-medium">{dims.find(d => d.key === activeDim)?.label}</span> dimension.
            Classify each AI/human disagreement so you don't assume every mismatch is an AI error — verify the gold label and question first.
            Marking one as <span className="font-medium">“Human label incorrect”</span> or <span className="font-medium">“Ambiguous”</span> tells you to fix the answer key/rubric, not the judge.
          </p>

          {totalDisagree > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className="font-medium">{totalAudited} of {totalDisagree} disagreements classified</span>
              {Object.entries(auditSummary).map(([cat, n]) => (
                <span key={cat} className="rounded-full bg-background px-2 py-0.5 text-muted-foreground">
                  {DISAGREEMENT_CATS.find(c => c[0] === cat)?.[1] ?? cat}: <span className="font-semibold tabular-nums">{n}</span>
                </span>
              ))}
              {totalAudited === 0 && <span className="text-muted-foreground">— use the “Disagreement cause” dropdown on each amber row to log why they differ.</span>}
            </div>
          )}

          <Card className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead className="text-center">Human panel</TableHead>
                  <TableHead className="text-center">AI judge</TableHead>
                  <TableHead>AI rationale</TableHead>
                  <TableHead>Disagreement cause</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map(({ it, r, humanVs, panelBin, panelMean, ai, aiScore, aiRationale, disagree }) => (
                  <TableRow key={it.id} className={disagree ? 'bg-amber-50' : ''}>
                    <TableCell className="max-w-[12rem] truncate" title={it.question}>{it.question}</TableCell>
                    <TableCell className="max-w-[9rem] truncate text-success" title={it.expected_answer || ''}>{it.expected_answer || '—'}</TableCell>
                    <TableCell className="max-w-[14rem] truncate text-muted-foreground" title={r?.response_text}>{r?.response_text || '—'}</TableCell>
                    <TableCell className="text-center" title={humanVs.map(j => `${labelFor(j.rater_id)}: ${j.score ?? j.verdict ?? '—'}`).join('\n')}>
                      <VerdictCell v={panelBin} s={isLikert ? (panelMean != null ? Math.round(panelMean) : undefined) : undefined} />
                      {humanVs.length > 1 && <div className="text-[10px] text-muted-foreground">{humanVs.length} reviewers</div>}
                    </TableCell>
                    <TableCell className="text-center"><VerdictCell v={ai} s={aiScore} /></TableCell>
                    <TableCell className="max-w-[12rem] truncate text-muted-foreground" title={aiRationale || ''}>{aiRationale || '—'}</TableCell>
                    <TableCell>
                      {disagree ? (
                        <div className="flex items-center gap-1">
                          <select
                            className={cn('w-full rounded-md border bg-background px-2 py-1 text-xs',
                              audits[`${r?.id}:${activeDim}`]?.category ? 'border-primary/50' : 'border-amber-400')}
                            value={audits[`${r?.id}:${activeDim}`]?.category ?? ''}
                            onChange={e => e.target.value && audit(r!.id, e.target.value as DisagreementCategory)}>
                            <option value="">Classify…</option>
                            {DISAGREEMENT_CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                          {audits[`${r?.id}:${activeDim}`]?.category && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
                        </div>
                      ) : <span className="text-[11px] text-muted-foreground">agree</span>}
                    </TableCell>
                  </TableRow>
                ))}
                {shown.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No rows</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  )
}
