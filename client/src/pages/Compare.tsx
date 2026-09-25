import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, GitCompare, Save, Info } from 'lucide-react'
import { api, type Comparison } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Badge } from '../components/ui/badge'
import { cn } from '../lib/utils'

// Per-agent comparison: the validated LLM judge scores every agent (Genie + uploaded external
// agents); here we name them and line up their scores per dimension. Kept separate from the
// Results page (which stays focused on Genie + judge validation).
export default function Compare() {
  const { id = '' } = useParams()
  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getComparison(id).then(c => {
      setCmp(c); setLoaded(true)
      setNames(Object.fromEntries((c.agents ?? []).map(a => [a.model_name, a.label])))
    }).catch(e => { setLoaded(true); toast.error((e as Error).message) })
  }, [id])

  const agents = cmp?.agents ?? []
  const dims = cmp?.dimensions ?? []
  const isLikert = cmp?.scale === 'likert'

  // Best score per dimension, to highlight the leading agent in each column.
  const bestByDim = useMemo(() => {
    const best: Record<string, number> = {}
    const likert = cmp?.scale === 'likert'
    for (const d of cmp?.dimensions ?? []) {
      let mx = -Infinity
      for (const a of cmp?.agents ?? []) {
        const s = a.dimensions[d.key]
        const v = likert ? s?.mean : s?.pass_rate
        if (v != null && v > mx) mx = v
      }
      if (mx > -Infinity) best[d.key] = mx
    }
    return best
  }, [cmp])

  const save = async () => {
    setSaving(true)
    try {
      const c = await api.saveAgentLabels(id, names)
      setCmp(c)
      setNames(Object.fromEntries((c.agents ?? []).map(a => [a.model_name, a.label])))
      toast.success('Agent names saved')
    } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
  }

  const scoreText = (v: number | null | undefined) =>
    v == null ? '—' : isLikert ? `${v.toFixed(2)} / 5` : `${Math.round(v * 100)}%`

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Project
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <GitCompare className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Comparison analysis</h1>
          {cmp && <Badge variant="secondary">{isLikert ? 'Likert (1–5)' : 'Binary'}</Badge>}
          <span className="text-sm text-muted-foreground">— each agent scored by your validated LLM judges</span>
        </div>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          These scores come from the AI judges (not the human panel). They're only as trustworthy as the judges —
          confirm <Link to={`/projects/${id}/results`} className="text-primary hover:underline">Judge trust</Link> on the Results page first.
        </p>
      </div>

      {!loaded ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Loading comparison…</CardContent></Card>
      ) : agents.length < 2 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nothing to compare yet. Upload a CSV with external-agent columns
          (<code>question | expected_answer | agent1_response | agent2_response …</code>), generate Genie answers,
          and grade — then each agent shows up here.
        </CardContent></Card>
      ) : (
        <>
          {/* 1. Name the agents */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Name the agents</h2>
            <p className="text-xs text-muted-foreground">Give each uploaded source a friendly name (e.g. “Claude”, “Claude + MCP”). Saved with the project.</p>
            <Card><CardContent className="grid gap-3 py-4 sm:grid-cols-2">
              {agents.map(a => (
                <label key={a.model_name} className="flex items-center gap-3 text-sm">
                  <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground" title={a.model_name}>
                    {a.model_name} <span className="text-muted-foreground/70">· {a.n}</span>
                  </span>
                  <Input value={names[a.model_name] ?? ''} placeholder={a.label}
                    onChange={e => setNames(n => ({ ...n, [a.model_name]: e.target.value }))} />
                </label>
              ))}
            </CardContent></Card>
            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={saving}><Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save names'}</Button>
            </div>
          </div>

          {/* 2. Scorecard */}
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Judge scorecard by dimension</h2>
            <p className="text-xs text-muted-foreground">
              {isLikert ? 'Mean judge score (1–5)' : 'Judge pass rate'} per dimension. The leading agent in each column is marked ★.
            </p>
            <Card className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-center">Responses</TableHead>
                    {dims.map(d => <TableHead key={d.key} className="text-center">{d.label}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map(a => {
                    const isGenie = a.model_name.startsWith('genie')
                    return (
                      <TableRow key={a.model_name} className={cn(isGenie && 'bg-muted/40')}>
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {a.label}
                            {isGenie && <Badge variant="secondary" className="text-[10px]">baseline</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-muted-foreground">{a.n}</TableCell>
                        {dims.map(d => {
                          const s = a.dimensions[d.key]
                          const v = isLikert ? s?.mean : s?.pass_rate
                          const isBest = v != null && bestByDim[d.key] != null && v === bestByDim[d.key]
                          return (
                            <TableCell key={d.key} className="text-center">
                              <span className={cn('tabular-nums', isBest && 'font-semibold text-success')}>
                                {scoreText(v)}{isBest && ' ★'}
                              </span>
                              {s && <div className="text-[10px] text-muted-foreground">n={s.n}</div>}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
