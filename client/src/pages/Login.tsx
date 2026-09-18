import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { CheckCircle2 } from 'lucide-react'
import { api, setSession, type Project } from '../lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Button } from '../components/ui/button'

export default function Login() {
  const [mode, setMode] = useState<'facilitator' | 'tester'>('facilitator')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  useEffect(() => { if (mode === 'tester') api.listProjects().then(setProjects).catch(() => {}) }, [mode])

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      const { user } = await api.login(email, mode === 'facilitator' ? password : undefined,
        mode === 'tester' ? projectId : undefined)
      setSession(user)
      nav(mode === 'tester' ? `/projects/${projectId}/review` : '/projects')
    } catch (err) { toast.error((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <CardTitle className="text-xl">GroundTruth</CardTitle>
          <CardDescription>Answer-key evaluation for AI responses</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'facilitator' | 'tester')} className="mb-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="facilitator">Facilitator</TabsTrigger>
              <TabsTrigger value="tester">Tester</TabsTrigger>
            </TabsList>
          </Tabs>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            {mode === 'facilitator' ? (
              <div className="space-y-1.5">
                <Label htmlFor="pw">Password</Label>
                <Input id="pw" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="proj">Project</Label>
                <select id="proj" className="flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={projectId} onChange={e => setProjectId(e.target.value)} required>
                  <option value="">Select a project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
