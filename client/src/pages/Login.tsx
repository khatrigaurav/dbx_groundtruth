import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api, setSession } from '../lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'

// No login form: Databricks Apps SSO identifies the user. On load we resolve who they are via
// /auth/whoami. Facilitators land on the project list; scoped reviewers are sent straight to the
// review screen for the project(s) they were invited to.
type Choice = { id: string; name: string }

export default function Login() {
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<Choice[] | null>(null)  // reviewer with >1 assignment
  const [noAssignments, setNoAssignments] = useState(false)
  const nav = useNavigate()

  async function signIn() {
    setError(null); setChoices(null); setNoAssignments(false)
    try {
      const { user, projects } = await api.whoami()
      setSession(user)
      if (user.role === 'facilitator') { nav('/projects'); return }
      // Scoped reviewer — restrict to their assigned project(s).
      if (!projects || projects.length === 0) { setNoAssignments(true); return }
      if (projects.length === 1) { nav(`/projects/${projects[0].id}/review`); return }
      setChoices(projects)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => { signIn() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <img src="/favicon.svg" alt="" aria-hidden className="mb-2 h-12 w-12" />
          <CardTitle className="text-2xl">GroundTruth</CardTitle>
          <CardDescription>Answer-key evaluation for AI responses</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          {error ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button className="w-full" onClick={signIn}>Try again</Button>
            </div>
          ) : noAssignments ? (
            <p className="text-sm text-muted-foreground">
              You don't have any review assignments yet. Ask your facilitator to invite you to a project.
            </p>
          ) : choices ? (
            <div className="space-y-2 text-left">
              <p className="mb-1 text-center text-sm text-muted-foreground">Choose a project to review:</p>
              {choices.map(c => (
                <Button key={c.id} variant="outline" className="w-full justify-start"
                  onClick={() => nav(`/projects/${c.id}/review`)}>{c.name}</Button>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Signing you in…
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
