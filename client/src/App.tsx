import { BrowserRouter, Navigate, Route, Routes, Link, useNavigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { CheckCircle2, LogOut } from 'lucide-react'
import { getSession, setSession } from './lib/api'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Review from './pages/Review'
import Results from './pages/Results'

function Shell({ children }: { children: React.ReactNode }) {
  const user = getSession()
  const nav = useNavigate()
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/projects" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <span>GroundTruth</span>
          </Link>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">{user.email}</span>
              <Badge variant={user.role === 'facilitator' ? 'default' : 'secondary'} className="capitalize">{user.role}</Badge>
              <Button variant="ghost" size="sm" onClick={() => { setSession(null); nav('/login') }}>
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  return getSession() ? <Shell>{children}</Shell> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster richColors position="top-center" />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/projects" element={<RequireAuth><Projects /></RequireAuth>} />
        <Route path="/projects/:id" element={<RequireAuth><ProjectDetail /></RequireAuth>} />
        <Route path="/projects/:id/review" element={<RequireAuth><Review /></RequireAuth>} />
        <Route path="/projects/:id/results" element={<RequireAuth><Results /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
