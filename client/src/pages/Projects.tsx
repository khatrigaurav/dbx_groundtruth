import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { FolderOpen, Plus } from 'lucide-react'
import { api, getSession, type Project, type Scale } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { cn } from '../lib/utils'

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scale, setScale] = useState<Scale | null>(null)
  const isFacilitator = getSession()?.role === 'facilitator'
  const nav = useNavigate()

  const load = () => api.listProjects().then(setProjects).catch(e => toast.error(e.message))
  useEffect(() => { load() }, [])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!scale) { toast.error('Choose a scoring scale'); return }
    try {
      const p = await api.createProject(name, scale, description)
      toast.success('Project created')
      setName(''); setDescription(''); setScale(null); setCreating(false)
      nav(`/projects/${p.id}`)
    } catch (e) { toast.error((e as Error).message) }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Evaluation projects you can access.</p>
        </div>
        {isFacilitator && (
          <Button onClick={() => setCreating(v => !v)}><Plus className="h-4 w-4" /> New project</Button>
        )}
      </div>

      {creating && isFacilitator && (
        <Card>
          <CardHeader><CardTitle>New project</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={create} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[1fr_2fr] md:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="n">Name</Label>
                  <Input id="n" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ARR Eval" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="d">Description</Label>
                  <Input id="d" value={description} onChange={e => setDescription(e.target.value)} placeholder="What are you evaluating?" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Scoring scale <span className="text-muted-foreground">— chosen now, locked afterwards</span></Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    ['binary', 'Binary', 'Pass / Fail — was the answer right or wrong?'],
                    ['likert', 'Likert (1–5)', 'Rate answer quality on a 1–5 scale.'],
                  ] as const).map(([val, label, desc]) => (
                    <button type="button" key={val} onClick={() => setScale(val)}
                      className={cn('rounded-lg border p-3 text-left transition-colors',
                        scale === val ? 'border-primary bg-accent ring-1 ring-primary/20' : 'hover:bg-muted')}>
                      <div className="text-sm font-medium">{label}</div>
                      <div className="text-xs text-muted-foreground">{desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={!scale}>Create</Button>
                <Button type="button" variant="ghost" onClick={() => { setCreating(false); setScale(null) }}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No projects yet.</p>
            {isFacilitator && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create one</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map(p => (
            <Card key={p.id} className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => nav(`/projects/${p.id}`)}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <Badge variant="muted">{p.item_count} items</Badge>
                </div>
                {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
