import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { api, setSession } from '../lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'

// No login form: Databricks Apps SSO identifies the user. On load we resolve who they are
// via /auth/whoami (forwarded identity headers) and continue. Access to the app itself is
// governed by Databricks app permissions.
export default function Login() {
  const [error, setError] = useState<string | null>(null)
  const nav = useNavigate()

  async function signIn() {
    setError(null)
    try {
      const { user } = await api.whoami()
      setSession(user)
      nav('/projects')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => { signIn() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

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
        <CardContent className="text-center">
          {error ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button className="w-full" onClick={signIn}>Try again</Button>
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
