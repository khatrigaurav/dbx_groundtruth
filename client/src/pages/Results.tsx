import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Info, Sparkles, RefreshCw, Users, Bot, Key,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Scale as ScaleIcon,
  ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react'
import {
  api, type Item, type JudgeScorecard, type Metrics, type Project, type User, type Verdict,
} from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Markdown } from '../components/Markdown'
import { cn } from '../lib/utils'

type V = Verdict | undefined
const majority = (vs: V[]): V => {
  const f = vs.filter(Boolean) as Verdict[]
  if (!f.length) return undefined
  return f.filter(v => v === 'pass').length * 2 >= f.length ? 'pass' : 'fail'
}

const fmt = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2))
const ciText = (ci?: [number | null, number | null]) =>
  ci && ci[0] != null && ci[1] != null ? `95% CI ${ci[0].toFixed(2)}–${ci[1].toFixed(2)}` : undefined

// --- trust gate styling ------------------------------------------------------
const GATE = {
  pass: { label: 'Trusted', cls: 'bg-success text-success-foreground', Icon: CheckCircle2 },
  review: { label: 'Spot-check', cls: 'bg-amber-500 text-white', Icon: AlertTriangle },
  fail: { label: 'Not ready', cls: 'bg-destructive text-destructive-foreground', Icon: XCircle },
  insufficient: { label: 'Need data', cls: 'bg-muted text-muted-foreground', Icon: HelpCircle },
} as const

function GateBadge({ verdict }: { verdict: keyof typeof GATE }) {
  const g = GATE[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', g.cls)}>
      <g.Icon className="h-3.5 w-3.5" /> {g.label}
    </span>
  )
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

// A labeled metric with an optional sub-line (CI) and hover explanation.
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

function Bias({ bias, scale }: { bias: number | null; scale: string }) {
  if (bias == null) return null
  const lenient = bias > 0
  const mag = Math.abs(bias)
  if (mag < (scale === 'likert' ? 0.15 : 0.03)) {
    return <span className="text-xs text-muted-foreground">well-calibrated (bias {bias >= 0 ? '+' : ''}{bias.toFixed(2)})</span>
  }
  return (
    <span className={cn('text-xs font-medium', lenient ? 'text-amber-600' : 'text-sky-600')}>
      {lenient ? 'lenient' : 'harsh'} · {bias >= 0 ? '+' : ''}{bias.toFixed(2)} vs humans
    </span>
  )
}

function JudgeCard({ card, scale, primary }: { card: JudgeScorecard; scale: string; primary: boolean }) {
  const isLikert = scale === 'likert'
  const insufficient = card.gate.verdict === 'insufficient'
  return (
    <Card className={cn(primary && 'ring-2 ring-primary/30')}>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold capitalize">{card.label.replace('AI · ', '')}</span>
            {card.judge_key === 'custom' && (
              <span className="inline-flex items-center rounded-full bg-violet-500 px-2.5 py-1 text-xs font-semibold text-white">Custom</span>
            )}
            {primary && <Badge variant="secondary" className="text-[10px]">primary</Badge>}
          </div>
          <GateBadge verdict={card.gate.verdict} />
        </div>
        <p className="text-xs text-muted-foreground">{card.gate.reason}</p>

        {insufficient ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
            {card.n} of the human-graded items overlap this judge. Grade more to unlock its scorecard.
          </div>
        ) : isLikert ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric big label="Spearman ρ" value={fmt(card.spearman)} sub={ciText(card.spearman_ci)}
                hint="Rank correlation between judge and human scores. 1 = identical ordering." />
              <Metric label="QWK" value={fmt(card.qwk)}
                hint="Quadratic weighted kappa — the standard ordinal-agreement metric for graded scoring." />
              <Metric label="MAE" value={fmt(card.mae)}
                hint="Mean absolute error between judge and human scores (points on the 1–5 scale)." />
              <Metric label="RMSE" value={fmt(card.rmse)} hint="Root-mean-square error — penalizes large misses more than MAE." />
              <Metric label="Judge mean" value={fmt(card.judge_mean)} hint="Average score this judge gave." />
              <Metric label="Human mean" value={fmt(card.human_mean)} hint="Average score the human panel gave on the same items." />
            </div>
            <Bias bias={card.bias} scale={scale} />
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric big label="F1" value={fmt(card.f1)} sub={ciText(card.f1_ci)}
                hint="Harmonic mean of precision and recall. Balances false positives and false negatives." />
              <Metric label="Cohen's κ" value={fmt(card.cohen_kappa)}
                hint="Chance-corrected agreement with the human panel. ≥0.6 substantial, ≥0.8 near-perfect." />
              <Metric label="MCC" value={fmt(card.mcc)}
                hint="Matthews correlation — robust to class imbalance. −1 to +1; >0.5 is strong." />
              <Metric label="Balanced acc." value={fmt(card.balanced_accuracy)}
                hint="Average of recall and specificity — fair when pass/fail rates are skewed." />
              <Metric label="Precision" value={fmt(card.precision)} hint="Of items the judge passed, how many humans also passed." />
              <Metric label="Recall" value={fmt(card.recall)} hint="Of items humans passed, how many the judge also passed." />
              <Metric label="Specificity" value={fmt(card.specificity)} hint="Of items humans failed, how many the judge also failed." />
              <Metric label="Accuracy" value={fmt(card.accuracy)} hint="Overall share of items where judge and human panel agree." />
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              {card.confusion && <Confusion c={card.confusion} />}
              <div className="sm:pl-2"><Bias bias={card.bias} scale={scale} /></div>
            </div>
          </>
        )}
        <div className="text-[11px] text-muted-foreground">Scored on {card.n} human-graded item(s).</div>
      </CardContent>
    </Card>
  )
}

function Overview({ m }: { m: Metrics }) {
  const cov = m.answer_key_coverage
  const tiles = [
    { icon: ScaleIcon, label: 'Panel agreement (α)', value: fmt(m.alpha_all), sub: ciText(m.alpha_all_ci) || `${m.n_judges + m.n_reviewers} raters`,
      hint: "Krippendorff's α across all raters (judges + humans). Measures how consistently everyone scores the same items. 1 = perfect, ≥0.8 strong." },
    { icon: Users, label: 'Reviewers · α', value: `${m.n_reviewers}`, sub: m.alpha_humans != null ? `humans α ${fmt(m.alpha_humans)}` : 'need ≥2 to compare',
      hint: 'Number of human reviewers, and their inter-rater agreement (α) with each other. Low human α means the task itself is subjective.' },
    { icon: Bot, label: 'AI judges', value: `${m.n_judges}`, sub: m.judges.map(j => j.label.replace('AI · ', '')).join(', ') || 'none',
      hint: 'How many LLM judges ran. Each is scored against the human panel in its own card below.' },
    { icon: Key, label: 'Gold-labeled', value: `${m.n_gold}`, sub: 'items with human verdicts',
      hint: 'Items graded by at least one human — the ground truth judges are measured against. More gold = more reliable metrics.' },
    { icon: Key, label: 'Answer-key coverage', value: cov.total ? `${Math.round((cov.with_key / cov.total) * 100)}%` : '—', sub: `${cov.with_key}/${cov.total} items`,
      hint: 'Share of questions that have an expected answer. Correctness judging and answer-key verification only apply to these.' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {tiles.map(t => (
        <Card key={t.label}><CardContent className="py-4">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <t.icon className="h-3.5 w-3.5" /> {t.label} <Tip text={t.hint} />
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</div>
          <div className="text-xs text-muted-foreground">{t.sub}</div>
        </CardContent></Card>
      ))}
    </div>
  )
}

function SummaryPanel({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const generate = async () => {
    setLoading(true); setErr(null)
    try {
      const r = await api.resultsSummary(id)
      if (r.summary) { setText(r.summary); setCollapsed(false) }
      else setErr(r.detail || 'No summary returned')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  const toggle = () => setCollapsed(c => !c)
  return (
    <Card className="border-primary/30 bg-accent/40">
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={text ? toggle : undefined} disabled={!text}
            className={cn('flex items-center gap-2 font-semibold', text && 'cursor-pointer hover:opacity-80')}
            aria-expanded={text ? !collapsed : undefined}>
            <Sparkles className="h-4 w-4 text-primary" /> AI summary
            {text && (collapsed
              ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
              : <ChevronUp className="h-4 w-4 text-muted-foreground" />)}
          </button>
          <div className="flex items-center gap-2">
            {text && (
              <Button size="sm" variant="ghost" onClick={toggle}>
                {collapsed ? <><ChevronDown className="h-4 w-4" /> Show</> : <><ChevronUp className="h-4 w-4" /> Hide</>}
              </Button>
            )}
            <Button size="sm" variant={text ? 'outline' : 'default'} onClick={generate} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {loading ? 'Analyzing…' : text ? 'Regenerate' : 'Summarize results'}
            </Button>
          </div>
        </div>
        {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
        {text ? (
          collapsed
            ? <button type="button" onClick={toggle} className="mt-2 text-xs text-primary hover:underline">Summary hidden — click to expand ▾</button>
            : <div className="mt-3"><Markdown>{text}</Markdown></div>
        ) : !err && (
          <p className="mt-2 text-sm text-muted-foreground">
            Get a plain-English read of whether your judges can be trusted, where they're biased, and what to do next.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function Results() {
  const { id = '' } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [members, setMembers] = useState<User[]>([])
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [filter, setFilter] = useState<'all' | 'disagree' | 'fail'>('all')

  useEffect(() => {
    api.getProject(id).then(setProject).catch(() => {})
    api.listItems(id).then(setItems).catch(() => {})
    api.listMembers(id).then(setMembers).catch(() => {})
    api.getMetrics(id).then(setMetrics).catch(() => {})
  }, [id])

  const isLikert = project?.scale === 'likert'
  const emailOf = useMemo(() => Object.fromEntries(members.map(m => [m.id, m.email])), [members])

  const judgeKeys = useMemo(() => {
    const s = new Set<string>()
    for (const it of items) for (const r of it.responses) for (const j of r.judgments)
      if (j.kind === 'llm' && j.judge_key) s.add(j.judge_key)
    return [...s]
  }, [items])

  const reviewerIds = useMemo(() => {
    const s = new Set<string>()
    for (const it of items) for (const r of it.responses) for (const j of r.judgments)
      if (j.kind === 'human' && j.rater_id && (j.verdict || j.score != null)) s.add(j.rater_id)
    return [...s]
  }, [items])

  const rows = useMemo(() => items.map(it => {
    const r = it.responses[0]
    const js = r?.judgments ?? []
    const byJudge: Record<string, { v?: V; s?: number }> = {}
    for (const k of judgeKeys) { const j = js.find(x => x.kind === 'llm' && x.judge_key === k); byJudge[k] = { v: j?.verdict as V, s: j?.score ?? undefined } }
    const byReviewer: Record<string, { v?: V; s?: number }> = {}
    for (const rid of reviewerIds) { const j = js.find(x => x.kind === 'human' && x.rater_id === rid); byReviewer[rid] = { v: j?.verdict as V, s: j?.score ?? undefined } }
    const primaryKey = judgeKeys.includes('correctness') ? 'correctness' : judgeKeys[0]
    const ai = primaryKey ? byJudge[primaryKey]?.v : undefined
    const human = majority(reviewerIds.map(rid => byReviewer[rid]?.v))
    return { it, r, byJudge, byReviewer, ai, human, disagree: !!(ai && human && ai !== human) }
  }), [items, judgeKeys, reviewerIds])

  const labelFor = (rid: string) => (emailOf[rid] || 'reviewer').split('@')[0]
  const shown = rows.filter(x => filter === 'all' ? true : filter === 'disagree' ? x.disagree : (x.human === 'fail' || x.ai === 'fail'))

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Results</h1>
          {project && <Badge variant="secondary">{isLikert ? 'Likert (1–5)' : 'Binary'}</Badge>}
          <span className="text-sm text-muted-foreground">— how well your AI judges match the human panel</span>
          {project?.experiment_url && (
            <a href={project.experiment_url} target="_blank" rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"
              title="Every AI judge and human verdict is logged as an assessment on each response's MLflow trace">
              <ExternalLink className="h-3.5 w-3.5" /> Validate in MLflow
            </a>
          )}
        </div>
      </div>

      <SummaryPanel id={id} />

      {metrics && <Overview m={metrics} />}

      {metrics?.small_sample && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Small sample — metrics below are noisy. Treat the confidence intervals seriously and grade more items before trusting a verdict.
          </CardContent>
        </Card>
      )}

      {/* Per-judge trust scorecards */}
      {metrics && metrics.judges.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {metrics.judges.map(card => (
            <JudgeCard key={card.judge_key} card={card} scale={metrics.scale}
              primary={card.judge_key === metrics.primary_judge} />
          ))}
        </div>
      ) : metrics && (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          {metrics.n_reviewers === 0
            ? 'No human reviews yet — judges can’t be validated until reviewers grade a sample.'
            : 'No AI judge results yet. Run the judges from the project page to score them against the panel.'}
        </CardContent></Card>
      )}

      {/* Per-item detail */}
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Per-item detail</h2>
        <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
          <TabsList>
            <TabsTrigger value="all">All ({rows.length})</TabsTrigger>
            <TabsTrigger value="disagree">Disagreements ({rows.filter(x => x.disagree).length})</TabsTrigger>
            <TabsTrigger value="fail">{isLikert ? 'Low scores' : 'Failures'}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Question</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Response</TableHead>
              {judgeKeys.map(k => <TableHead key={k} className="text-center">AI · {k}</TableHead>)}
              {reviewerIds.map(rid => <TableHead key={rid} className="text-center">{labelFor(rid)}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(({ it, r, byJudge, byReviewer, disagree }) => (
              <TableRow key={it.id} className={disagree ? 'bg-amber-50' : ''}>
                <TableCell className="max-w-[14rem] truncate" title={it.question}>{it.question}</TableCell>
                <TableCell className="max-w-[10rem] truncate text-success" title={it.expected_answer || ''}>{it.expected_answer || '—'}</TableCell>
                <TableCell className="max-w-[16rem] truncate text-muted-foreground" title={r?.response_text}>{r?.response_text || '—'}</TableCell>
                {judgeKeys.map(k => <TableCell key={k} className="text-center"><VerdictCell v={byJudge[k]?.v} s={byJudge[k]?.s} /></TableCell>)}
                {reviewerIds.map(rid => <TableCell key={rid} className="text-center"><VerdictCell v={byReviewer[rid]?.v} s={byReviewer[rid]?.s} /></TableCell>)}
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow><TableCell colSpan={3 + judgeKeys.length + reviewerIds.length} className="py-10 text-center text-muted-foreground">No rows</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
