import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Info } from 'lucide-react'
import { api, type Item, type Metrics, type Project, type User, type Verdict } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'

type V = Verdict | undefined
const majority = (vs: V[]): V => {
  const f = vs.filter(Boolean) as Verdict[]
  if (!f.length) return undefined
  return f.filter(v => v === 'pass').length * 2 >= f.length ? 'pass' : 'fail'
}

function VerdictCell({ v, s }: { v?: V; s?: number }) {
  if (s != null) return <Badge variant={s >= 3 ? 'success' : 'destructive'}>{s}</Badge>
  if (!v) return <Badge variant="muted">—</Badge>
  return <Badge variant={v === 'pass' ? 'success' : 'destructive'} className="capitalize">{v}</Badge>
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card><CardContent className="py-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </CardContent></Card>
  )
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
const fmt = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2))

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
    // Primary AI = correctness if present, else first judge.
    const primaryKey = judgeKeys.includes('correctness') ? 'correctness' : judgeKeys[0]
    const ai = primaryKey ? byJudge[primaryKey]?.v : undefined
    const human = majority(reviewerIds.map(rid => byReviewer[rid]?.v))
    return { it, r, byJudge, byReviewer, ai, human, disagree: !!(ai && human && ai !== human) }
  }), [items, judgeKeys, reviewerIds])

  // Binary judge-quality metrics: correctness judge vs reviewer majority (ground truth).
  const m = useMemo(() => {
    const scored = rows.filter(x => x.ai && x.human)
    let tp = 0, fp = 0, fn = 0, tn = 0
    for (const x of scored) {
      if (x.ai === 'pass' && x.human === 'pass') tp++
      else if (x.ai === 'pass' && x.human === 'fail') fp++
      else if (x.ai === 'fail' && x.human === 'pass') fn++
      else tn++
    }
    const n = scored.length
    const po = n ? (tp + tn) / n : 0
    const aiPass = (tp + fp) / (n || 1), humanPass = (tp + fn) / (n || 1)
    const pe = aiPass * humanPass + (1 - aiPass) * (1 - humanPass)
    const kappa = n && pe < 1 ? (po - pe) / (1 - pe) : NaN
    const precision = tp + fp ? tp / (tp + fp) : NaN
    const recall = tp + fn ? tp / (tp + fn) : NaN
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : NaN
    return { n, tp, fp, fn, tn, agreement: po, kappa, precision, recall, f1 }
  }, [rows])

  const labelFor = (rid: string) => (emailOf[rid] || 'reviewer').split('@')[0]
  const shown = rows.filter(x => filter === 'all' ? true : filter === 'disagree' ? x.disagree : (x.human === 'fail' || x.ai === 'fail'))

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Results</h1>
          {project && <Badge variant="secondary">{isLikert ? 'Likert (1–5)' : 'Binary'}</Badge>}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Krippendorff's α (all raters)" value={fmt(metrics?.alpha_all)} hint={`${metrics?.n_raters ?? 0} raters · ${metrics?.n_units_multi_rated ?? 0} co-rated`} />
        <Stat label="α (reviewers only)" value={fmt(metrics?.alpha_humans)} hint="human inter-rater agreement" />
        {isLikert ? (
          <>
            <Stat label="Judges" value={`${judgeKeys.length}`} hint={judgeKeys.join(', ') || 'none'} />
            <Stat label="Reviewers" value={`${reviewerIds.length}`} hint="people who scored" />
          </>
        ) : (
          <>
            <Stat label="Correctness vs reviewers" value={pct(m.tp + m.tn, m.n)} hint={`κ ${fmt(m.kappa)} · F1 ${fmt(m.f1)}`} />
            <Stat label="Confusion" value={`${m.tp}/${m.fp}/${m.fn}/${m.tn}`} hint="TP / FP / FN / TN" />
          </>
        )}
      </div>

      <Card><CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Info className="h-3.5 w-3.5" /> α ranges to 1.0 (perfect); ≥0.8 is strong, ≥0.667 tentative agreement.</span>
        {!isLikert && <span>Correctness judge scored against the reviewer majority (ground truth).</span>}
      </CardContent></Card>

      <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="disagree">Disagreements</TabsTrigger>
          <TabsTrigger value="fail">{isLikert ? 'Low scores' : 'Failures'}</TabsTrigger>
        </TabsList>
      </Tabs>

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
                <TableCell className="text-success">{it.expected_answer || '—'}</TableCell>
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
