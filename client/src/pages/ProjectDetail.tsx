import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowLeft, ArrowRight, Check, Upload, Sparkles, FileSpreadsheet, ExternalLink,
  Gavel, UserPlus, ClipboardCheck, BarChart3, Trash2, User as UserIcon, Server,
  Loader2, Lock, AlertTriangle, Ban, ChevronDown,
} from 'lucide-react'
import {
  api, getSession, type GenerationMode, type Item, type JudgeCatalogItem,
  type Project, type ProjectJudge, type User, type Verdict,
} from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Badge } from '../components/ui/badge'
import { cn } from '../lib/utils'

function hasHuman(js: { kind: string; verdict?: Verdict; score?: number }[]) {
  return js.some(j => j.kind === 'human' && (j.verdict || j.score != null))
}
function hasLlm(js: { kind: string; verdict?: Verdict; score?: number }[]) {
  return js.some(j => j.kind === 'llm' && (j.verdict || j.score != null))
}

export default function ProjectDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [members, setMembers] = useState<User[]>([])
  const [catalog, setCatalog] = useState<JudgeCatalogItem[]>([])
  const [models, setModels] = useState<string[]>([])
  const [judges, setJudges] = useState<Record<string, ProjectJudge>>({})
  const [busy, setBusy] = useState(false)
  const [openStep, setOpenStep] = useState<string | null>(null)
  // Independent expand state for the two sub-panels inside the merged Generate+Grade step.
  const [subOpen, setSubOpen] = useState<{ gen: boolean; judge: boolean }>({ gen: true, judge: true })
  const [inviteEmail, setInviteEmail] = useState('')
  const [genMode, setGenMode] = useState<GenerationMode>('sp')
  const [generating, setGenerating] = useState(false)      // a generation run is in flight
  const [cancelling, setCancelling] = useState(false)      // a cancel has been requested
  const [genError, setGenError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isFacilitator = getSession()?.role === 'facilitator'

  const load = () => {
    api.getProject(id).then(p => {
      setProject(p)
      const seed: Record<string, ProjectJudge> = {}
      for (const j of p.judges) seed[j.judge_key] = j
      if (Object.keys(seed).length === 0) seed['correctness'] = { judge_key: 'correctness', enabled: true }
      setJudges(seed)
    }).catch(e => toast.error(e.message))
    api.listItems(id).then(setItems).catch(() => {})
    api.listMembers(id).then(setMembers).catch(() => {})
  }
  useEffect(() => { load() }, [id])
  useEffect(() => { api.judgeCatalog().then(c => { setCatalog(c.judges); setModels(c.models) }).catch(() => {}) }, [])
  // Resume the pending state if a background generation is still running (e.g. after a reload).
  useEffect(() => {
    api.generateStatus(id).then(s => { if (s.status === 'running') { setGenerating(true); pollBackground() } }).catch(() => {})
  }, [id])  // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const withKey = items.filter(i => i.expected_answer).length
    const answered = items.filter(i => i.responses.length > 0).length
    const graded = items.filter(i => i.responses.some(r => hasLlm(r.judgments))).length
    const reviewed = items.filter(i => i.responses.some(r => hasHuman(r.judgments))).length
    const testers = members.filter(m => m.role === 'tester').length
    return { total: items.length, withKey, answered, graded, reviewed, testers,
             pending: items.length - answered }
  }, [items, members])

  const activeStep = stats.total === 0 ? 'data'
    : (stats.answered < stats.total || stats.graded === 0) ? 'work'
    : stats.reviewed === 0 ? 'review' : 'results'

  const userToggled = useRef(false)
  useEffect(() => { if (!userToggled.current) setOpenStep(activeStep) }, [activeStep])
  const toggleStep = (key: string) => { userToggled.current = true; setOpenStep(openStep === key ? null : key) }

  async function upload() {
    const f = fileRef.current?.files?.[0]; if (!f) { toast.error('Choose a file first'); return }
    setBusy(true)
    try { const r = await api.uploadCsv(id, f); toast.success(r.detail || 'Imported'); load() }
    catch (e) { toast.error((e as Error).message) } finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function generate() {
    setBusy(true); setGenerating(true); setCancelling(false); setGenError(null)
    const t = toast.loading('Starting generation…')
    try {
      const r = await api.generate(id, genMode)
      const errs = r.errors || []
      if (errs.length) {                          // immediate failure (e.g. no user token)
        toast.error(errs[0] || r.detail || 'Failed', { id: t })
        setGenError(errs.join(' • ')); setGenerating(false); return
      }
      if (/no questions awaiting/i.test(r.detail || '')) {  // nothing to do
        toast.message(r.detail || 'Nothing to generate', { id: t }); setGenerating(false); return
      }
      toast.success(r.detail || 'Generating…', { id: t })
      pollBackground()                            // both modes run in the background now
    } catch (e) {
      toast.error((e as Error).message, { id: t }); setGenError((e as Error).message); setGenerating(false)
    } finally { setBusy(false) }
  }

  function pollBackground() {
    const tick = async () => {
      try {
        const s = await api.generateStatus(id)
        if (s.status === 'running' || s.status === 'cancelling') {  // still in progress
          setCancelling(s.status === 'cancelling')
          load(); setTimeout(tick, 4000); return
        }
        setGenerating(false); setCancelling(false)
        if (s.status === 'cancelled') {
          toast.message(s.detail || 'Generation cancelled')
        } else if (s.status === 'error' || (s.errors && s.errors.length)) {
          const raw = (s.errors && s.errors.join(' • ')) || ''
          setGenError(s.detail ? (raw ? `${s.detail}\n\n${raw}` : s.detail) : (raw || 'Generation failed'))
          toast.error(s.detail || 'Generation failed')
        } else if (s.status === 'done') {
          toast.success(s.detail || `Generated ${s.generated ?? ''} answer(s)`)
        }
        load()
      } catch { setTimeout(tick, 5000) }  // transient poll error — keep trying
    }
    setTimeout(tick, 2500)
  }

  async function cancelGen() {
    setCancelling(true)
    try { const r = await api.cancelGenerate(id); toast.message(r.detail || 'Cancelling…') }
    catch (e) { toast.error((e as Error).message); setCancelling(false) }
  }

  function toggleJudge(key: string) {
    setJudges(prev => {
      const next = { ...prev }
      if (next[key]?.enabled) { next[key] = { ...next[key], enabled: false } }
      else { next[key] = { judge_key: key, enabled: true, instructions: next[key]?.instructions, model: next[key]?.model } }
      return next
    })
  }
  function setJudgeField(key: string, field: 'instructions' | 'model', value: string) {
    setJudges(prev => ({ ...prev, [key]: { ...prev[key], judge_key: key, enabled: prev[key]?.enabled ?? true, [field]: value } }))
  }
  async function saveJudges() {
    const list = Object.values(judges).filter(j => j.enabled)
    if (list.length === 0) { toast.error('Enable at least one judge'); return }
    try { await api.setJudgeConfig(id, list); toast.success('Judges saved'); load() }
    catch (e) { toast.error((e as Error).message) }
  }
  async function runJudge() {
    const list = Object.values(judges).filter(j => j.enabled)
    if (list.length === 0) { toast.error('Enable at least one judge'); return }
    setBusy(true); const t = toast.loading(`Running ${list.length} judge(s)…`)
    try {
      await api.setJudgeConfig(id, list)
      const r = await api.runJudge(id); toast.success(r.detail || 'Graded', { id: t }); load()
    } catch (e) { toast.error((e as Error).message, { id: t }) } finally { setBusy(false) }
  }
  async function remove() {
    if (!window.confirm(`Delete project "${project?.name}"? This removes all its questions, responses, grades, and its MLflow experiment. This cannot be undone.`)) return
    try { const r = await api.deleteProject(id); toast.success(r.detail || 'Project deleted'); nav('/projects') }
    catch (e) { toast.error((e as Error).message) }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault()
    try { await api.inviteMember(id, inviteEmail); toast.success(`Invited ${inviteEmail}`); setInviteEmail(''); load() }
    catch (e) { toast.error((e as Error).message) }
  }
  async function toggleBlind(enabled: boolean) {
    try { await api.setBlindReview(id, enabled); toast.success(enabled ? 'Blind review on' : 'Blind review off'); load() }
    catch (e) { toast.error((e as Error).message) }
  }

  if (!project) return <p className="text-sm text-muted-foreground">Loading…</p>

  if (!isFacilitator) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <Card><CardContent className="flex items-center justify-between py-6">
          <div><div className="font-medium">Review responses</div>
            <div className="text-sm text-muted-foreground">Score each AI response against its expected answer.</div></div>
          <Button asChild><Link to={`/projects/${id}/review`}><ClipboardCheck className="h-4 w-4" /> Start reviewing</Link></Button>
        </CardContent></Card>
      </div>
    )
  }

  const done = {
    data: stats.total > 0,
    work: stats.total > 0 && stats.answered === stats.total && stats.graded > 0,
    review: stats.reviewed > 0, results: false,
  }
  const scaleLabel = project.scale === 'likert' ? 'Likert (1–5)' : 'Binary (pass/fail)'

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to="/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Projects
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <Badge variant="secondary">{scaleLabel}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {project.description || 'Upload questions with known answers, generate responses with Genie, grade them with AI judges, confirm with reviewers, then compare.'}
        </p>
      </div>

      {(project.experiment_url || project.genie_url) && (
        <Card><CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-sm">
          {project.experiment_url && (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={project.experiment_url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> MLflow experiment
            </a>
          )}
          {project.genie_url && project.genie_last_run_mode === 'user' && (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={project.genie_url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Your Genie One history
            </a>
          )}
        </CardContent></Card>
      )}

      <ol className="space-y-3">
        <Step n={1} title="Add questions" active={activeStep === 'data'} done={done.data}
          desc="Upload a pipe-delimited file of questions and their known-correct answers (the answer key)."
          status={stats.total ? `${stats.total} question${stats.total > 1 ? 's' : ''} · ${stats.withKey} with an answer key` : 'None yet'}
          open={openStep === 'data'} onToggle={() => toggleStep('data')}
          actionLabel={stats.total ? 'Add more' : 'Add questions'}>
          <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <FileSpreadsheet className="h-4 w-4" /> Pipe-delimited columns: <code>question | expected_answer</code>
            <span className="text-xs">(a <code>response</code> column is optional — skips generation). Use <code>|</code> so commas in text are safe.</span>
          </p>
          <div className="flex gap-2">
            <Input ref={fileRef} type="file" accept=".csv,.txt,.psv" className="cursor-pointer p-1.5" />
            <Button disabled={busy} onClick={upload}><Upload className="h-4 w-4" /> Upload</Button>
          </div>
        </Step>

        <Step n={2} title="Generate answers & grade" active={activeStep === 'work'} done={done.work}
          desc="Kick off Genie and set up your AI judges together — pick judges while answers are still generating, then grade."
          status={stats.total ? `${stats.answered}/${stats.total} answered · ${stats.graded} graded` : 'Add questions first'}
          open={openStep === 'work'} onToggle={() => toggleStep('work')} actionLabel="Open"
          locked={stats.total === 0}>
          <div className="space-y-3">
            {/* Sub-step A — generate */}
            <SubPanel title="Generate answers (Genie)"
              done={stats.total > 0 && stats.answered === stats.total}
              status={stats.total ? `${stats.answered} of ${stats.total} answered` : ''}
              open={subOpen.gen} onToggle={() => setSubOpen(s => ({ ...s, gen: !s.gen }))}>
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <button type="button" disabled={generating} onClick={() => setGenMode('sp')}
                    className={cn('rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                      genMode === 'sp' ? 'border-primary bg-accent ring-1 ring-primary/20' : 'hover:bg-muted')}>
                    <div className="flex items-center gap-1.5 text-sm font-medium"><Server className="h-4 w-4" /> Background (recommended)</div>
                    <div className="text-xs text-muted-foreground">Runs as the app service principal. Reliable; ~1–2 min per question. Won't appear in your Genie One history.</div>
                  </button>
                  <button type="button" disabled={generating} onClick={() => setGenMode('user')}
                    className={cn('rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                      genMode === 'user' ? 'border-primary bg-accent ring-1 ring-primary/20' : 'hover:bg-muted')}>
                    <div className="flex items-center gap-1.5 text-sm font-medium"><UserIcon className="h-4 w-4" /> Run as me</div>
                    <div className="text-xs text-muted-foreground">Runs on your behalf — uses your data access and shows in your Genie One history.</div>
                  </button>
                </div>
                <div className="flex gap-2">
                  <Button disabled={busy || generating || stats.pending === 0} onClick={generate}>
                    {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {generating ? 'Generating…' : `Generate ${stats.pending || ''} answer${stats.pending === 1 ? '' : 's'}`}
                  </Button>
                  {generating && (
                    <Button variant="outline" onClick={cancelGen} disabled={cancelling}>
                      <Ban className="h-4 w-4" /> {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                </div>
                {generating && (
                  <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    {cancelling
                      ? 'Cancelling — no new questions will start; answers already in flight will finish.'
                      : <>Generating via Genie — {stats.answered} of {stats.total} done. Takes ~a minute per question; set up judges below while it runs.</>}
                  </div>
                )}
                {genError && !generating && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div><div className="font-medium">Generation failed</div><div className="whitespace-pre-wrap break-words text-xs">{genError}</div></div>
                  </div>
                )}
                {stats.total > 0 && stats.pending === 0 && !generating && (
                  <p className="text-xs text-muted-foreground">All {stats.total} questions already have answers — nothing to generate. (Upload a file without a <code>response</code> column if you want the app to generate them.)</p>
                )}
              </div>
            </SubPanel>

            {/* Sub-step B — judges (available immediately, so you configure while Genie runs) */}
            <SubPanel title="AI judges"
              done={stats.graded > 0}
              status={`${Object.values(judges).filter(j => j.enabled).length} selected${stats.answered ? ` · ${stats.graded}/${stats.answered} graded` : ''}`}
              open={subOpen.judge} onToggle={() => setSubOpen(s => ({ ...s, judge: !s.judge }))}>
              <div className="space-y-3">
                {catalog.map(j => {
                  const on = judges[j.key]?.enabled
                  return (
                    <div key={j.key} className={cn('rounded-lg border p-3', on && 'border-primary/50 bg-accent/40')}>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input type="checkbox" className="mt-1" checked={!!on} onChange={() => toggleJudge(j.key)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                            {j.label}
                            {j.uses_answer_key
                              ? <Badge variant="success" className="text-[10px]">uses answer key</Badge>
                              : <Badge variant="muted" className="text-[10px]">quality only</Badge>}
                            {j.needs_context && <Badge variant="muted" className="text-[10px]">needs context</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">{j.description}</div>
                        </div>
                      </label>
                      {on && (j.is_custom || j.key === 'guidelines') && (
                        <Textarea rows={2} className="mt-2" placeholder="Grading instructions…"
                          value={judges[j.key]?.instructions || ''}
                          onChange={e => setJudgeField(j.key, 'instructions', e.target.value)} />
                      )}
                    </div>
                  )
                })}
                {catalog.some(j => judges[j.key]?.enabled && j.uses_answer_key) && stats.withKey < stats.answered && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Correctness/custom judges compare against the answer key. {stats.answered - stats.withKey} of {stats.answered} answered questions have no <code>expected_answer</code>, so those will be skipped by those judges.</span>
                  </div>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Judge model (all judges)</div>
                    <select className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                      value={judges['correctness']?.model || models[0] || ''}
                      onChange={e => Object.keys(judges).forEach(k => setJudgeField(k, 'model', e.target.value))}>
                      {models.map(mm => <option key={mm} value={mm}>{mm}</option>)}
                    </select>
                  </div>
                  <Button variant="outline" size="sm" onClick={saveJudges}>Save judges</Button>
                  <Button size="sm" disabled={busy || stats.answered === 0} onClick={runJudge}>
                    <Gavel className="h-4 w-4" /> Grade with AI
                  </Button>
                </div>
                {stats.answered === 0 && (
                  <p className="text-xs text-muted-foreground">Pick your judges now — grading unlocks as soon as answers are generated above.</p>
                )}
              </div>
            </SubPanel>
          </div>
        </Step>

        <Step n={3} title="Human review" active={activeStep === 'review'} done={done.review}
          desc="Invite people to independently score responses, so you can trust the AI judges."
          status={`${stats.testers} reviewer${stats.testers === 1 ? '' : 's'} · ${stats.reviewed} of ${stats.total} reviewed`}
          open={openStep === 'review'} onToggle={() => toggleStep('review')} actionLabel="Manage reviewers"
          locked={stats.answered === 0}>
          <form onSubmit={invite} className="mb-3 flex gap-2">
            <Input placeholder="reviewer@company.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required />
            <Button type="submit"><UserPlus className="h-4 w-4" /> Invite</Button>
          </form>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {members.filter(m => m.role === 'tester').map(m => <Badge key={m.id} variant="secondary">{m.email}</Badge>)}
            {stats.testers === 0 && <span className="text-sm text-muted-foreground">No reviewers invited yet.</span>}
          </div>
          <label className="mb-3 flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={project.blind_review} onChange={e => toggleBlind(e.target.checked)} />
            <span><span className="font-medium">Blind review</span> — hide the expected answer from reviewers while they judge (reduces bias). You still see it.</span>
          </label>
          <Button variant="outline" onClick={() => nav(`/projects/${id}/review`)}><ClipboardCheck className="h-4 w-4" /> Review responses yourself</Button>
        </Step>

        <Step n={4} title="Compare results" active={activeStep === 'results'} done={done.results}
          desc="See where the AI judges and your reviewers agree — with Krippendorff's α across the whole panel."
          status={stats.graded || stats.reviewed ? 'Ready to view' : 'Grade or review first'}
          open={false} onToggle={() => nav(`/projects/${id}/results`)}
          actionLabel="View results" actionIcon={<BarChart3 className="h-4 w-4" />}
          onAction={() => nav(`/projects/${id}/results`)} inlineAction
          locked={stats.graded === 0 && stats.reviewed === 0} />
      </ol>

      <div className="flex justify-end border-t pt-4">
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={remove}>
          <Trash2 className="h-4 w-4" /> Delete project
        </Button>
      </div>
    </div>
  )
}

function Step(props: {
  n: number; title: string; desc: string; status: string; active: boolean; done: boolean
  open: boolean; onToggle: () => void; actionLabel: string; actionIcon?: React.ReactNode
  onAction?: () => void; actionDisabled?: boolean; inlineAction?: boolean; locked?: boolean
  children?: React.ReactNode
}) {
  const { n, title, desc, status, active, done, open, onToggle, actionLabel, actionIcon, onAction, actionDisabled, inlineAction, locked, children } = props
  const isOpen = open && !locked
  return (
    <li>
      <Card className={cn(active && !locked && 'border-primary/60 ring-1 ring-primary/20', locked && 'opacity-55')}>
        <CardContent className="py-4">
          <div className="flex items-start gap-4">
            <div className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-semibold',
              done ? 'bg-success text-success-foreground' : locked ? 'bg-muted text-muted-foreground' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
              {done ? <Check className="h-4 w-4" /> : locked ? <Lock className="h-3.5 w-3.5" /> : n}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">{title}</div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{status}</span>
                  <Button size="sm" variant={active && !locked ? 'default' : 'outline'}
                    disabled={actionDisabled || locked}
                    onClick={() => (inlineAction && onAction ? onAction() : onToggle())}>
                    {!locked && actionIcon}{actionLabel}{!inlineAction && !locked && <ArrowRight className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
              {isOpen && children && <div className="mt-4 rounded-lg border bg-muted/30 p-3">{children}</div>}
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  )
}

// A collapsible sub-panel used inside the merged Generate+Grade step, so the two sub-steps
// can be expanded independently (configure judges while generation runs).
function SubPanel(props: {
  title: string; status?: string; done?: boolean; open: boolean; onToggle: () => void
  children: React.ReactNode
}) {
  const { title, status, done, open, onToggle, children } = props
  return (
    <div className="rounded-lg border bg-card">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full',
            done ? 'bg-success text-success-foreground' : 'border border-muted-foreground/30')}>
            {done && <Check className="h-3 w-3" />}
          </span>
          {title}
        </span>
        <span className="flex items-center gap-2">
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && <div className="border-t px-3 py-3">{children}</div>}
    </div>
  )
}
