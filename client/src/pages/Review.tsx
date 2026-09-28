import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Check, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { api, baselineResponse, getSession, type Item, type JudgeCatalogItem, type Project, type Verdict } from '../lib/api'
import { cacheGet, cacheKey, cacheSet } from '../lib/cache'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Textarea } from '../components/ui/textarea'
import { Markdown } from '../components/Markdown'
import { cn } from '../lib/utils'

// Human-friendly dimension labels (kept in step with the backend judge catalog).
const DIM_LABELS: Record<string, string> = {
  correctness: 'Correctness', relevance: 'Relevance', safety: 'Safety',
  groundedness: 'Groundedness', guidelines: 'Guidelines', custom: 'Custom', overall: 'Overall',
}
const dimLabel = (k: string) => DIM_LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1)

type Sel = Record<string, { verdict?: Verdict; score?: number }>

// Shows the scoring rubric for a dimension: a high-level snippet by default (a long custom
// instruction dump would swamp the page), expandable to the full text.
function Rubric({ text, authored }: { text: string; authored: boolean }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 160
  const shown = open || !long ? text : text.slice(0, 160).replace(/\s+\S*$/, '') + '…'
  return (
    <div className="mb-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
      <span className="font-semibold text-foreground">{authored ? 'Scoring rubric: ' : 'Scores: '}</span>{shown}
      {long && (
        <button type="button" onClick={() => setOpen(o => !o)} className="ml-1 font-medium text-primary hover:underline">
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

export default function Review() {
  const { id = '' } = useParams()
  const user = getSession()
  const isFac = user?.role === 'facilitator'  // reviewers have no project page to go back to
  // Seed from the session cache so a revisit (or arriving from the project page) paints instantly.
  const [project, setProject] = useState<Project | null>(() => cacheGet<Project>(cacheKey('project', id)) ?? null)
  const [items, setItems] = useState<Item[]>(() => cacheGet<Item[]>(cacheKey('items', id)) ?? [])
  const [itemsLoaded, setItemsLoaded] = useState<boolean>(() => cacheGet<Item[]>(cacheKey('items', id)) !== undefined)
  const [idx, setIdx] = useState(0)
  const [rationale, setRationale] = useState('')
  const [sel, setSel] = useState<Sel>({})
  const [catalog, setCatalog] = useState<JudgeCatalogItem[]>([])
  const savedRationale = useRef('')
  // Mirrors `sel` synchronously so rapid clicks across dimensions merge correctly instead of
  // racing on the render closure (which caused auto-advance to miss dimensions).
  const selRef = useRef<Sel>({})
  // The (item + dimensions) signature we last seeded local selections for. Guards the seed effect
  // so background item updates (optimistic patches) never re-seed and clobber live clicks.
  const seededSig = useRef<string>('')
  const isLikert = project?.scale === 'likert'

  useEffect(() => {
    api.listItems(id).then(v => { setItems(cacheSet(cacheKey('items', id), v)); setItemsLoaded(true) }).catch(() => setItemsLoaded(true))
  }, [id])
  useEffect(() => { api.getProject(id).then(v => setProject(cacheSet(cacheKey('project', id), v))).catch(() => {}) }, [id])
  useEffect(() => { api.judgeCatalog().then(c => setCatalog(c.judges)).catch(() => {}) }, [])

  // Dimensions = the project's enabled AI judges (1-1). Each carries the scoring rubric so the
  // reviewer knows the criteria — the facilitator's own instructions for guidelines/custom
  // judges, else the built-in judge's description. Falls back to a single "overall" verdict when
  // no judges are configured.
  const catById = useMemo(() => Object.fromEntries(catalog.map(c => [c.key, c])), [catalog])
  const dims = useMemo(() => {
    const enabled = (project?.judges || []).filter(j => j.enabled !== false)
    const keys = enabled.length ? enabled.map(j => j.judge_key) : ['overall']
    return keys.map(k => {
      const pj = enabled.find(j => j.judge_key === k)
      const rubric = (pj?.instructions || project?.judge_instructions || catById[k]?.description
        || (k === 'overall' ? 'Overall quality of the response.' : '')).trim()
      // guidelines/custom rubrics are facilitator-authored; built-ins describe what they check.
      const authored = !!(pj?.instructions || (project?.judge_instructions && (k === 'guidelines' || k === 'custom')))
      return { key: k, label: dimLabel(k), rubric, authored }
    })
  }, [project, catById])

  const item = items[idx]
  const response = item ? baselineResponse(item) : undefined

  // A reviewer's stored verdict for one dimension (legacy null-dimension rows count as "overall").
  // "mine" is stamped server-side (and on optimistic local rows), so re-hydration doesn't depend
  // on the client session id matching the server-resolved rater_id.
  const myDim = (r: Item['responses'][number] | undefined, dim: string) =>
    r?.judgments.find(j => j.kind === 'human' && j.mine
      && (j.judge_key === dim || (dim === 'overall' && !j.judge_key)))

  const hasSel = (v?: { verdict?: Verdict; score?: number }) =>
    isLikert ? v?.score != null : v?.verdict != null
  const allScored = (s: Sel) => dims.length > 0 && dims.every(d => hasSel(s[d.key]))

  // Seed local selections + comment from stored judgments only when the DISPLAYED item (or the
  // dimension set) changes — never on a background items update, so optimistic patches and saves
  // in flight can't overwrite what the reviewer is actively clicking.
  useEffect(() => {
    if (!item) return
    const sig = `${item.id}|${dims.map(d => d.key).join(',')}`
    if (seededSig.current === sig) return
    seededSig.current = sig
    const s: Sel = {}
    let note = ''
    for (const d of dims) {
      const j = myDim(response, d.key)
      if (j) { s[d.key] = { verdict: j.verdict, score: j.score ?? undefined }; note = note || (j.rationale || '') }
    }
    selRef.current = s; setSel(s); setRationale(note); savedRationale.current = note
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, dims])

  // Per-item completeness for the navigator (how many dimensions this reviewer has scored).
  const myStates = useMemo(() => items.map(it => {
    const r = baselineResponse(it)
    let done = 0
    for (const d of dims) { if (hasSel({ verdict: myDim(r, d.key)?.verdict, score: myDim(r, d.key)?.score ?? undefined })) done++ }
    return { done, total: dims.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items, user, dims, isLikert])

  // Patch the reviewer's verdicts into the local items in memory (and the shared cache), so the
  // navigator, a return-visit, and a revisit all reflect them instantly — no server round-trip
  // on the scoring path.
  function patchItems(responseId: string, nextSel: Sel, note: string) {
    const apply = (list: Item[]): Item[] => list.map(it => {
      const r = baselineResponse(it)
      if (!r || r.id !== responseId) return it
      const judgments = [...r.judgments]
      for (const d of dims) {
        const v = nextSel[d.key]
        if (!v || (v.verdict == null && v.score == null)) continue
        const at = judgments.findIndex(j => j.kind === 'human' && j.mine
          && (j.judge_key === d.key || (d.key === 'overall' && !j.judge_key)))
        const row = { id: at >= 0 ? judgments[at].id : `local:${responseId}:${d.key}`,
          kind: 'human' as const, rater_id: user?.id, mine: true, judge_key: d.key,
          verdict: v.verdict, score: v.score, rationale: note }
        if (at >= 0) judgments[at] = row; else judgments.push(row)
      }
      // Replace the reviewed response by id (it may not be responses[0] once agent responses exist).
      return { ...it, responses: it.responses.map(rr => rr.id === r.id ? { ...rr, judgments } : rr) }
    })
    setItems(prev => apply(prev))
    const cached = cacheGet<Item[]>(cacheKey('items', id))
    if (cached) cacheSet(cacheKey('items', id), apply(cached))
  }

  // Optimistic, non-blocking save: update local state now, persist in the background.
  function save(nextSel: Sel) {
    if (!response) return
    const payload = dims
      .map(d => ({ judge_key: d.key, ...(nextSel[d.key] || {}) }))
      .filter(d => d.verdict != null || d.score != null)
    if (payload.length === 0 && rationale === savedRationale.current) return
    patchItems(response.id, nextSel, rationale)
    savedRationale.current = rationale
    api.submitJudgments(response.id, { rater_id: user?.id, rationale, dims: payload })
      .catch(e => toast.error((e as Error).message))
  }

  function pick(dimKey: string, value: Verdict | number) {
    const prev = selRef.current
    const next: Sel = { ...prev, [dimKey]: isLikert ? { score: value as number } : { verdict: value as Verdict } }
    selRef.current = next
    setSel(next)
    save(next)
    // Advance only on the click that COMPLETES the item (all dimensions now scored) — not on
    // every click, and not when re-editing an already-complete item.
    if (allScored(next) && !allScored(prev) && idx < items.length - 1) setIdx(idx + 1)
  }

  function goTo(next: number) {
    save(selRef.current)  // flush any comment edit before switching
    setIdx(Math.max(0, Math.min(items.length - 1, next)))
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        {isFac && <Link to={`/projects/${id}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>}
        {/* Cold load: show a skeleton instead of a misleading "no questions" flash until the fetch lands. */}
        {!itemsLoaded ? (
          <Card><CardContent className="space-y-3 py-6">
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-20 animate-pulse rounded bg-muted" />
            <div className="h-9 animate-pulse rounded bg-muted" />
          </CardContent></Card>
        ) : (
          <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No questions to review yet.</CardContent></Card>
        )}
      </div>
    )
  }
  if (!item) return null
  const reviewedCount = myStates.filter(s => s.total > 0 && s.done === s.total).length

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      {/* Question navigator */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        {isFac && <Link to={`/projects/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>}
        <div className="mb-2 text-xs text-muted-foreground">{reviewedCount} of {items.length} reviewed</div>
        <div className="max-h-[70vh] space-y-1 overflow-auto pr-1">
          {items.map((it, i) => {
            const s = myStates[i]
            const full = s.total > 0 && s.done === s.total
            const partial = s.done > 0 && !full
            return (
              <button key={it.id} onClick={() => goTo(i)}
                className={cn('flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors',
                  i === idx ? 'border-primary bg-accent' : 'border-transparent hover:bg-muted')}>
                <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]',
                  full ? 'bg-success text-success-foreground'
                    : partial ? 'bg-amber-400 text-amber-950'
                      : 'bg-muted text-muted-foreground')}>
                  {full ? <Check className="h-3 w-3" /> : partial ? `${s.done}` : i + 1}
                </span>
                <span className="truncate">{it.question}</span>
              </button>
            )
          })}
        </div>
        {dims.length > 1 && (
          <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Score each response on {dims.length} dimensions: {dims.map(d => d.label).join(', ')}.
          </div>
        )}
      </aside>

      {/* Current item */}
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <div className="text-right text-sm text-muted-foreground">Question {idx + 1} of {items.length}</div>
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Question</div>
              <div className="text-[15px]">{item.question}</div>
            </div>
            {/* Blind review: reviewers don't see the answer key while judging (facilitators still do). */}
            {item.expected_answer && !(project?.blind_review && !isFac) && (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expected answer</div>
                <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success">{item.expected_answer}</div>
              </div>
            )}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Response{response?.model_name ? ` · ${response.model_name}` : ''}</div>
              <div className="rounded-md border bg-muted/40 px-3 py-2">
                {response ? <Markdown>{response.response_text}</Markdown> : <span className="text-sm text-muted-foreground">(no response)</span>}
              </div>
            </div>

            <div>
              <Textarea placeholder="Comment (optional) — saved automatically" rows={2}
                value={rationale} onChange={e => setRationale(e.target.value)} onBlur={() => save(selRef.current)} />
            </div>

            {/* One control group per dimension (1-1 with the enabled AI judges). */}
            <div className="space-y-3">
              {dims.map(d => {
                const cur = sel[d.key]
                return (
                  <div key={d.key} className="rounded-md border bg-card px-3 py-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium">{d.label}</span>
                      {!hasSel(cur) && <span className="text-[11px] text-muted-foreground">not scored</span>}
                    </div>
                    {d.rubric && <Rubric text={d.rubric} authored={d.authored} />}
                    {isLikert ? (
                      <div className="flex gap-2">
                        {[1, 2, 3, 4, 5].map(n => (
                          <Button key={n} size="sm" variant={cur?.score === n ? 'default' : 'outline'} className="flex-1"
                            disabled={!response} onClick={() => pick(d.key, n)}>{n}</Button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex gap-3">
                        <Button size="sm" variant={cur?.verdict === 'pass' ? 'success' : 'outline'} className="flex-1"
                          disabled={!response} onClick={() => pick(d.key, 'pass')}><Check className="h-4 w-4" /> Pass</Button>
                        <Button size="sm" variant={cur?.verdict === 'fail' ? 'destructive' : 'outline'} className="flex-1"
                          disabled={!response} onClick={() => pick(d.key, 'fail')}><X className="h-4 w-4" /> Fail</Button>
                      </div>
                    )}
                  </div>
                )
              })}
              {isLikert && <div className="text-[11px] text-muted-foreground">Rate 1 (poor) to 5 (excellent) per dimension.</div>}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" disabled={idx === 0} onClick={() => goTo(idx - 1)}><ChevronLeft className="h-4 w-4" /> Previous</Button>
          <Button variant="ghost" size="sm" disabled={idx >= items.length - 1} onClick={() => goTo(idx + 1)}>Next <ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  )
}
