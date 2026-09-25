import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowLeft, Info, Sparkles, RefreshCw, Users, Bot, Key,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Layers,
  ChevronDown, ChevronUp, ChevronRight, ExternalLink, FlaskConical,
} from 'lucide-react'
import {
  api, baselineResponse, type AiVsHuman, type DimensionCard as DimCard, type DisagreementAudit,
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

// Like Tip, but renders the bubble into document.body via a portal with fixed positioning, so
// it escapes clipping ancestors (the comparison table's overflow-x-auto clipped the inline Tip).
function InfoTip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const x = Math.min(Math.max(r.left + r.width / 2, 120), window.innerWidth - 120)
    setPos({ x, y: r.top })
  }
  const hide = () => setPos(null)
  return (
    <span ref={ref} tabIndex={0} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
      className="inline-flex cursor-help align-middle outline-none">
      <Info className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground focus:text-muted-foreground" />
      {pos && createPortal(
        <span role="tooltip"
          style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)', zIndex: 100, pointerEvents: 'none' }}
          className="w-56 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-background shadow-lg">
          {text}
        </span>,
        document.body)}
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
        <Metric big label="Balanced acc." value={fmt(a.balanced_accuracy)} sub={ciText(a.balanced_accuracy_ci)} />
        <Metric label="MCC" value={fmt(a.mcc)} />
        <Metric label="Cohen's κ" value={fmt(a.cohen_kappa)} />
        <Metric label="F1" value={fmt(a.f1)} />
        <Metric label="Precision" value={fmt(a.precision)} />
        <Metric label="Recall" value={fmt(a.recall)} />
        <Metric label="Specificity" value={fmt(a.specificity)} />
        <Metric label="Accuracy" value={fmt(a.accuracy)} />
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
        <Metric big label="Spearman ρ" value={fmt(a.spearman)} sub={ciText(a.spearman_ci)} />
        <Metric label="QWK" value={fmt(a.qwk)} />
        <Metric label="MAE" value={fmt(a.mae)} />
        <Metric label="RMSE" value={fmt(a.rmse)} />
        <Metric label="Judge mean" value={fmt(a.judge_mean)} />
        <Metric label="Human mean" value={fmt(a.human_mean)} />
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
              <span className="inline-flex items-center rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">Custom</span>
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

// --- Executive band (Tier 1) ------------------------------------------------
// Severity for picking the "weakest" judge to surface (most concerning first).
const GATE_SEVERITY: Record<string, number> = { fail: 0, review: 1, insufficient: 2, pass: 3 }

// The dimension whose human labels drive the headline System-quality number:
// the primary dimension, else the first with an AI-vs-human scorecard, else the first.
function headlineDim(m: Metrics): DimCard | null {
  const dims = m.dimensions ?? []
  if (!dims.length) return null
  const byKey = (k: string | null | undefined) => (k ? dims.find(d => d.key === k) : undefined)
  return byKey(m.primary_dimension) ?? dims.find(d => d.ai_vs_human) ?? dims[0]
}

// System quality = how good the answers are, read from the TRUSTED human labels
// (pass rate on binary, mean score on likert) — not from the AI judge. `plain` says in
// words what the number is; `detail` carries the sample size.
function qualityText(a: AiVsHuman | null | undefined, isLikert: boolean): { value: string; plain: string; detail: string } | null {
  if (!a) return null
  const graded = `${a.n} answer${a.n === 1 ? '' : 's'} graded`
  if (isLikert) {
    if (a.human_mean == null) return null
    return { value: `${a.human_mean.toFixed(1)} / 5`, plain: 'average score from human review', detail: graded }
  }
  if (a.human_pass_rate == null) return null
  return { value: `${Math.round(a.human_pass_rate * 100)}%`, plain: 'of answers passed human review', detail: graded }
}

// Short per-dimension quality chip so a single headline never hides a weak dimension.
function dimShort(d: DimCard, isLikert: boolean): string | null {
  const a = d.ai_vs_human
  if (!a) return null
  if (isLikert) return a.human_mean == null ? null : `${d.label} ${a.human_mean.toFixed(1)}`
  return a.human_pass_rate == null ? null : `${d.label} ${Math.round(a.human_pass_rate * 100)}%`
}

function ExecBand({ m, isLikert }: { m: Metrics; isLikert: boolean }) {
  const dims = m.dimensions ?? []
  const hd = headlineDim(m)
  const q = qualityText(hd?.ai_vs_human, isLikert)
  const chips = dims.length > 1 ? (dims.map(d => dimShort(d, isLikert)).filter(Boolean) as string[]) : []

  const judged = dims.filter(d => d.has_ai_judge)
  const ready = judged.filter(d => d.gate.verdict === 'pass').length
  const worst = judged
    .filter(d => d.gate.verdict !== 'pass')
    .sort((a, b) => GATE_SEVERITY[a.gate.verdict] - GATE_SEVERITY[b.gate.verdict])[0]
  const alphas = dims.map(d => d.human).filter(h => h.computable && h.alpha != null).map(h => h.alpha as number)
  const minAlpha = alphas.length ? Math.min(...alphas) : null

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Tile A — System quality: is the product good? */}
      <Card>
        <CardContent className="py-5">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            System quality
            <Tip text="Share of the answers under test that human reviewers rated a pass — how good the answers are, per humans. This is the product signal, and it comes from the human panel, NOT the AI judge (whose reliability is shown as Judge trust)." />
          </div>
          {q ? (
            <>
              <div className="mt-1 text-4xl font-semibold tabular-nums">{q.value}</div>
              <div className="mt-1 text-sm text-foreground">{q.plain}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{hd?.label} · {q.detail}</div>
              {chips.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">By dimension</div>
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((c, i) => (
                      <span key={i} className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{c}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="mt-2 text-sm text-muted-foreground">Not enough human labels yet — have reviewers grade a sample to see system quality.</div>
          )}
        </CardContent>
      </Card>

      {/* Tile B — Judge trust: can we believe that number? */}
      <Card>
        <CardContent className="py-5">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Judge trust
            <Tip text="Whether the AI judges can be believed vs. the human panel. It gates how much to trust the system-quality number: a shaky judge means the quality read is only as strong as the small human-labeled sample." />
          </div>
          {judged.length > 0 ? (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tabular-nums">{ready}<span className="text-2xl text-muted-foreground">/{judged.length}</span></span>
                <span className="text-sm text-muted-foreground">judges ready</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {worst ? (
                  <><GateBadge verdict={worst.gate.verdict} hint={nextStep(worst)} /><span className="text-xs text-muted-foreground">weakest: {worst.label}</span></>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> all dimensions trustworthy</span>
                )}
              </div>
              {minAlpha != null && (
                <div className="mt-2 text-[11px] text-muted-foreground">Panel agreement (Krippendorff α) as low as {minAlpha.toFixed(2)} across dimensions.</div>
              )}
            </>
          ) : (
            <div className="mt-2 text-sm text-muted-foreground">No AI judges configured yet.</div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// --- Per-dimension comparison table (Tier 2) --------------------------------
// Subtle color ramp so accuracy differences pop down a column. Conventional
// bands: accuracy-like (≥.80 good / ≥.65 ok) vs correlation-like (≥.60 / ≥.40).
function metricTone(kind: 'acc' | 'corr', v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return ''
  const [good, ok] = kind === 'acc' ? [0.8, 0.65] : [0.6, 0.4]
  return v >= good ? 'text-success' : v >= ok ? 'text-amber-600' : 'text-destructive'
}

function NumCell({ v, tone }: { v: number | null | undefined; tone?: string }) {
  return <TableCell className="text-center"><span className={cn('tabular-nums', tone)}>{fmt(v)}</span></TableCell>
}

const HUMAN_A_HINT = "Inter-reviewer Krippendorff's α for this dimension — do reviewers agree on the rubric? Low α means an ambiguous rubric, not necessarily a bad judge."
const ITEMS_HINT = 'Number of human-labeled items this scorecard is computed on.'
const GATE_HINT = 'Readiness verdict combining the signals — whether this judge can be trusted on this dimension.'

function JudgeComparison({ dims, isLikert, primaryDim, onSelect, selected }: {
  dims: DimCard[]; isLikert: boolean; primaryDim: string | null
  onSelect: (key: string) => void; selected: string | null
}) {
  const cols: { label: string; hint: string }[] = isLikert
    ? [
        { label: 'Spearman ρ', hint: 'Rank correlation between judge and human scores. 1 = identical ordering.' },
        { label: 'QWK', hint: 'Quadratic weighted kappa — the standard ordinal-agreement metric for graded scoring.' },
        { label: 'MAE', hint: 'Mean absolute error between judge and human scores (points on 1–5). Lower is better.' },
        { label: 'Human α', hint: HUMAN_A_HINT }, { label: 'Items', hint: ITEMS_HINT }, { label: 'Gate', hint: GATE_HINT },
      ]
    : [
        { label: 'Bal. acc.', hint: 'Average of recall and specificity — the headline metric under class imbalance (plain accuracy misleads when most labels are one class).' },
        { label: 'MCC', hint: 'Matthews correlation — robust to class imbalance. −1 to +1; >0.5 strong.' },
        { label: "Cohen's κ", hint: 'Chance-corrected agreement with the human panel. ≥0.6 substantial, ≥0.8 near-perfect.' },
        { label: 'F1', hint: 'Harmonic mean of precision and recall. Can look high even when specificity is 0 — read alongside balanced accuracy.' },
        { label: 'Human α', hint: HUMAN_A_HINT }, { label: 'Items', hint: ITEMS_HINT }, { label: 'Gate', hint: GATE_HINT },
      ]
  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Dimension</TableHead>
            {cols.map(c => (
              <TableHead key={c.label} className="text-center">
                <span className="inline-flex items-center justify-center gap-1">{c.label}<InfoTip text={c.hint} /></span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {dims.map(d => {
            const a = d.ai_vs_human
            const primary = d.key === primaryDim
            const has = d.has_ai_judge && a && d.n_gold > 0
            return (
              <TableRow key={d.key} onClick={() => onSelect(d.key)}
                title="Click to inspect this judge's scorecard & per-item audit"
                className={cn('cursor-pointer transition-colors hover:bg-muted/60',
                  primary && 'bg-primary/5',
                  selected === d.key && 'bg-primary/10 ring-1 ring-inset ring-primary/40')}>
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {d.label}
                    {d.key === 'custom' && <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">Custom</span>}
                    {primary && <Badge variant="secondary" className="text-[10px]">primary</Badge>}
                  </span>
                </TableCell>
                {!has ? (
                  <TableCell colSpan={cols.length} className="text-center text-xs text-muted-foreground">
                    {!d.has_ai_judge ? 'no AI judge for this dimension' : 'no overlapping human + AI labels yet'}
                  </TableCell>
                ) : (
                  <>
                    {isLikert ? (
                      <>
                        <NumCell v={a!.spearman} tone={metricTone('corr', a!.spearman)} />
                        <NumCell v={a!.qwk} tone={metricTone('corr', a!.qwk)} />
                        <NumCell v={a!.mae} />
                      </>
                    ) : (
                      <>
                        <NumCell v={a!.balanced_accuracy} tone={metricTone('acc', a!.balanced_accuracy)} />
                        <NumCell v={a!.mcc} tone={metricTone('corr', a!.mcc)} />
                        <NumCell v={a!.cohen_kappa} tone={metricTone('corr', a!.cohen_kappa)} />
                        <NumCell v={a!.f1} tone={metricTone('acc', a!.f1)} />
                      </>
                    )}
                    {d.human.computable
                      ? <NumCell v={d.human.alpha} tone={metricTone('corr', d.human.alpha)} />
                      : <TableCell className="text-center text-muted-foreground">—</TableCell>}
                    <TableCell className="text-center tabular-nums">{a!.n ?? d.n_gold}</TableCell>
                    <TableCell className="text-center"><GateBadge verdict={d.gate.verdict} hint={nextStep(d)} /></TableCell>
                  </>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

type CachedSummary = { text: string | null; note: string | null; at: string | null }

function SummaryPanel({ id }: { id: string }) {
  // Seed from the session cache for an instant paint; the persisted copy on the project
  // (Lakebase/SQLite) is the durable source of truth, fetched on mount below.
  const cached = cacheGet<CachedSummary>(cacheKey('summary', id))
  const [text, setText] = useState<string | null>(cached?.text ?? null)
  const [note, setNote] = useState<string | null>(cached?.note ?? null)
  const [at, setAt] = useState<string | null>(cached?.at ?? null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(true)   // expanded by default once a summary exists

  const apply = (r: { summary?: string | null; fallback?: boolean; note?: string; at?: string | null }) => {
    const nextNote = r.fallback ? (r.note || 'Computed read (LLM unavailable).') : null
    setText(r.summary || null); setNote(nextNote); setAt(r.at ?? null)
    cacheSet(cacheKey('summary', id), { text: r.summary || null, note: nextNote, at: r.at ?? null })
  }

  // Load the last-saved summary from the backend so it persists across reloads and users.
  // Inlined (not via `apply`) so the effect's only dependency is the project id.
  useEffect(() => {
    let live = true
    api.getResultsSummary(id).then(r => {
      if (!live || !r?.summary) return
      const n = r.fallback ? (r.note || 'Computed read (LLM unavailable).') : null
      setText(r.summary); setNote(n); setAt(r.at ?? null)
      cacheSet(cacheKey('summary', id), { text: r.summary, note: n, at: r.at ?? null })
    }).catch(() => {})
    return () => { live = false }
  }, [id])

  const generate = async () => {
    setLoading(true); setErr(null); setNote(null)
    try {
      const r = await api.resultsSummary(id)
      if (r.summary) { apply(r); setOpen(true) }
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
            {at && <p className="mt-3 text-[11px] text-muted-foreground">Generated {new Date(at).toLocaleString()} · saved</p>}
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
  const [detailDim, setDetailDim] = useState<string>('')
  const [filter, setFilter] = useState<'all' | 'disagree'>('all')
  const detailRef = useRef<HTMLDivElement>(null)
  // Per-item rows the user expanded to read the full question/response/AI rationale.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set())
  const toggleRow = (rid: string) => setExpandedRows(s => {
    const n = new Set(s)
    if (n.has(rid)) n.delete(rid); else n.add(rid)
    return n
  })

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
  const activeDim = detailDim || primaryDim || dims[0]?.key || ''
  const detailCard = dims.find(d => d.key === activeDim) ?? null

  // Overview table → detail drilldown: pick a judge (toggle off if it's already open) and
  // scroll its scorecard + per-item audit into view. Switching judges via the in-panel tabs
  // uses setDetailDim directly, so it doesn't yank the scroll position.
  const openDetail = (key: string) => {
    setDetailDim(prev => {
      const next = prev === key ? '' : key
      if (next) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      return next
    })
  }

  // Open the primary judge's detail once, on first load, so first-time users see the drilldown
  // exists (without auto-scrolling). After that, row clicks / the Hide button own the state.
  const firstKey = primaryDim || dims[0]?.key || ''
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!autoOpened.current && firstKey) {
      autoOpened.current = true
      setDetailDim(firstKey)
    }
  }, [firstKey])

  // Per-item diagnostics for the ACTIVE dimension: human panel vs AI, with a disagreement audit.
  const rows = useMemo(() => items.map(it => {
    const r = baselineResponse(it)
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
          <span className="text-sm text-muted-foreground">— how good the answers are, and whether the judges can be trusted</span>
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

      {/* Tier 1 — Executive band: is it good, and can we believe the number? */}
      {metrics && dims.length > 0 && <ExecBand m={metrics} isLikert={isLikert} />}

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

      {/* Tier 2 — Explore by dimension: line up each judge, click one to drill in */}
      {!metricsLoaded && dims.length === 0 ? (
        <CardsSkeleton />
      ) : dims.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Explore by dimension</h2>
          <p className="text-xs text-muted-foreground">Click a row to inspect that judge's scorecard and per-item audit below.</p>
          <JudgeComparison dims={dims} isLikert={isLikert} primaryDim={primaryDim} onSelect={openDetail} selected={detailDim || null} />
        </div>
      ) : (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          {metrics?.n_reviewers === 0
            ? 'No human reviews yet — judges can’t be validated until reviewers grade a sample.'
            : 'No judges configured yet. Build AI judges on the project page, then grade.'}
        </CardContent></Card>
      )}

      {/* Tier 3 — Detail for ONE selected judge: its scorecard + per-item audit */}
      {dims.length > 0 && detailDim && detailCard && (
        <div ref={detailRef} className="space-y-4 scroll-mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Judge detail</h2>
              <Tabs value={activeDim} onValueChange={setDetailDim}>
                <TabsList>
                  {dims.map(d => <TabsTrigger key={d.key} value={d.key}>{d.label}</TabsTrigger>)}
                </TabsList>
              </Tabs>
            </div>
            <button type="button" onClick={() => setDetailDim('')}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronUp className="h-3.5 w-3.5" /> Hide
            </button>
          </div>
          <DimensionCard card={detailCard} scale={metrics!.scale} primary={detailCard.key === primaryDim} />

          {/* Per-item diagnostics + gold-label audit, scoped to the selected dimension */}
          <div className="space-y-3 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Per-item diagnostics &amp; gold-label audit</h3>
              <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
                <TabsList>
                  <TabsTrigger value="all">All ({rows.length})</TabsTrigger>
                  <TabsTrigger value="disagree">Disagreements ({rows.filter(x => x.disagree).length})</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <p className="text-xs text-muted-foreground">
              Showing the <span className="font-medium">{detailCard.label}</span> dimension.
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
                {shown.map(({ it, r, humanVs, panelBin, panelMean, ai, aiScore, aiRationale, disagree }) => {
                  const isOpen = expandedRows.has(it.id)
                  return (
                  <Fragment key={it.id}>
                  <TableRow onClick={() => toggleRow(it.id)}
                    title="Click to expand full question, response & AI rationale"
                    className={cn('cursor-pointer', disagree ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-muted/50', isOpen && 'border-b-0')}>
                    <TableCell className="max-w-[12rem]">
                      <span className="flex items-center gap-1.5">
                        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                        <span className="truncate">{it.question}</span>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[9rem] truncate text-success">{it.expected_answer || '—'}</TableCell>
                    <TableCell className="max-w-[14rem] truncate text-muted-foreground">{r?.response_text || '—'}</TableCell>
                    <TableCell className="text-center" title={humanVs.map(j => `${labelFor(j.rater_id)}: ${j.score ?? j.verdict ?? '—'}`).join('\n')}>
                      <VerdictCell v={panelBin} s={isLikert ? (panelMean != null ? Math.round(panelMean) : undefined) : undefined} />
                      {humanVs.length > 1 && <div className="text-[10px] text-muted-foreground">{humanVs.length} reviewers</div>}
                    </TableCell>
                    <TableCell className="text-center"><VerdictCell v={ai} s={aiScore} /></TableCell>
                    <TableCell className="max-w-[12rem] truncate text-muted-foreground">{aiRationale || '—'}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
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
                  {isOpen && (
                    <TableRow className={cn(disagree ? 'bg-amber-50' : 'bg-muted/30', 'hover:bg-transparent')}>
                      <TableCell colSpan={7} className="py-3">
                        <dl className="grid gap-x-4 gap-y-2 pl-5 text-sm sm:grid-cols-[7rem_1fr]">
                          <dt className="font-medium text-muted-foreground">Question</dt>
                          <dd className="whitespace-pre-wrap">{it.question}</dd>
                          <dt className="font-medium text-muted-foreground">Expected</dt>
                          <dd className="whitespace-pre-wrap text-success">{it.expected_answer || '—'}</dd>
                          <dt className="font-medium text-muted-foreground">Response</dt>
                          <dd className="whitespace-pre-wrap">{r?.response_text || '—'}</dd>
                          <dt className="font-medium text-muted-foreground">AI rationale</dt>
                          <dd className="whitespace-pre-wrap">{aiRationale || <span className="text-muted-foreground">— (no rationale recorded)</span>}</dd>
                        </dl>
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                  )
                })}
                {shown.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No rows</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
          </div>
        </div>
      )}
    </div>
  )
}
