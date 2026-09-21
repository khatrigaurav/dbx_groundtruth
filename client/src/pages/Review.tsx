import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Check, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { api, getSession, type Item, type Project, type Verdict } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Textarea } from '../components/ui/textarea'
import { Markdown } from '../components/Markdown'
import { cn } from '../lib/utils'

export default function Review() {
  const { id = '' } = useParams()
  const user = getSession()
  const isFac = user?.role === 'facilitator'  // reviewers have no project page to go back to
  const [project, setProject] = useState<Project | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [idx, setIdx] = useState(0)
  const [rationale, setRationale] = useState('')
  const savedRationale = useRef('')
  const isLikert = project?.scale === 'likert'

  useEffect(() => { api.listItems(id).then(setItems).catch(() => {}) }, [id])
  useEffect(() => { api.getProject(id).then(setProject).catch(() => {}) }, [id])

  const item = items[idx]
  const response = item?.responses[0]
  const myJudgment = useMemo(
    () => response?.judgments.find(j => j.kind === 'human' && j.rater_id === user?.id),
    [response, user],
  )
  const myVerdict = myJudgment?.verdict
  const myScore = myJudgment?.score
  const scored = isLikert ? myScore != null : !!myVerdict

  useEffect(() => {
    const r = myJudgment?.rationale || ''
    setRationale(r); savedRationale.current = r
  }, [idx, myJudgment])

  // Per-item done-state for the navigator list.
  const myStates = useMemo(() => items.map(it => {
    const r = it.responses[0]
    const j = r?.judgments.find(x => x.kind === 'human' && x.rater_id === user?.id)
    return { verdict: j?.verdict, score: j?.score }
  }), [items, user])

  // Persist a comment edit without changing the score (fixes lost-comment bug).
  async function flushComment() {
    if (!response || !scored) return
    if (rationale === savedRationale.current) return
    try {
      await api.submitJudgment(response.id, { verdict: myVerdict, score: myScore, rationale, rater_id: user?.id })
      savedRationale.current = rationale
      const fresh = await api.listItems(id); setItems(fresh)
      toast.success('Comment saved')
    } catch (e) { toast.error((e as Error).message) }
  }

  async function goTo(next: number) {
    await flushComment()
    setIdx(Math.max(0, Math.min(items.length - 1, next)))
  }

  async function judgeBinary(verdict: Verdict) {
    if (!response) return
    try {
      await api.submitJudgment(response.id, { verdict, rationale, rater_id: user?.id })
      savedRationale.current = rationale
      const fresh = await api.listItems(id); setItems(fresh)
      toast.success(`Marked ${verdict}`)
      if (idx < items.length - 1) setIdx(idx + 1)
    } catch (e) { toast.error((e as Error).message) }
  }

  async function judgeScore(score: number) {
    if (!response) return
    try {
      await api.submitJudgment(response.id, { score, rationale, rater_id: user?.id })
      savedRationale.current = rationale
      const fresh = await api.listItems(id); setItems(fresh)
      toast.success(`Rated ${score}`)
      if (idx < items.length - 1) setIdx(idx + 1)
    } catch (e) { toast.error((e as Error).message) }
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        {isFac && <Link to={`/projects/${id}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>}
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No questions to review yet.</CardContent></Card>
      </div>
    )
  }
  if (!item) return null
  const reviewedCount = myStates.filter(s => s.verdict || s.score != null).length

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      {/* Question navigator */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        {isFac && <Link to={`/projects/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Project</Link>}
        <div className="mb-2 text-xs text-muted-foreground">{reviewedCount} of {items.length} reviewed</div>
        <div className="max-h-[70vh] space-y-1 overflow-auto pr-1">
          {items.map((it, i) => {
            const s = myStates[i]
            return (
              <button key={it.id} onClick={() => goTo(i)}
                className={cn('flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors',
                  i === idx ? 'border-primary bg-accent' : 'border-transparent hover:bg-muted')}>
                <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]',
                  s.verdict === 'pass' ? 'bg-success text-success-foreground'
                    : s.verdict === 'fail' ? 'bg-destructive text-destructive-foreground'
                      : s.score != null ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground')}>
                  {s.verdict === 'pass' ? <Check className="h-3 w-3" /> : s.verdict === 'fail' ? <X className="h-3 w-3" /> : s.score != null ? s.score : i + 1}
                </span>
                <span className="truncate">{it.question}</span>
              </button>
            )
          })}
        </div>
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
            {item.expected_answer && (
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
                value={rationale} onChange={e => setRationale(e.target.value)} onBlur={flushComment} />
            </div>

            {isLikert ? (
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">Rate 1 (poor) to 5 (excellent)</div>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Button key={n} variant={myScore === n ? 'default' : 'outline'} className="flex-1" disabled={!response} onClick={() => judgeScore(n)}>
                      {n}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <Button variant={myVerdict === 'pass' ? 'success' : 'outline'} className="flex-1" disabled={!response} onClick={() => judgeBinary('pass')}>
                  <Check className="h-4 w-4" /> Pass
                </Button>
                <Button variant={myVerdict === 'fail' ? 'destructive' : 'outline'} className="flex-1" disabled={!response} onClick={() => judgeBinary('fail')}>
                  <X className="h-4 w-4" /> Fail
                </Button>
              </div>
            )}
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
