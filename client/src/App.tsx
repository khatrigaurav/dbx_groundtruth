import { BrowserRouter, Navigate, Route, Routes, Link } from 'react-router-dom'
import { Toaster } from 'sonner'
import { CheckCircle2 } from 'lucide-react'
import { getSession } from './lib/api'
import { Badge } from './components/ui/badge'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Review from './pages/Review'
import Results from './pages/Results'

function Shell({ children }: { children: React.ReactNode }) {
  const user = getSession()
  const isFac = user?.role === 'facilitator'
  const brand = (
    <>
      <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <CheckCircle2 className="h-4 w-4" />
      </span>
      <span>GroundTruth</span>
    </>
  )
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          {/* Reviewers have no project list to go back to, so the brand isn't a link for them. */}
          {isFac
            ? <Link to="/projects" className="flex items-center gap-2 font-semibold">{brand}</Link>
            : <span className="flex items-center gap-2 font-semibold">{brand}</span>}
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">{user.email}</span>
              <Badge variant={isFac ? 'default' : 'secondary'}>{isFac ? 'Facilitator' : 'Reviewer'}</Badge>
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

// Facilitator-only pages. A signed-in reviewer is bounced to /login, which re-resolves their
// identity and routes them to their scoped review screen.
function RequireFacilitator({ children }: { children: React.ReactNode }) {
  const user = getSession()
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'facilitator') return <Navigate to="/login" replace />
  return <Shell>{children}</Shell>
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster richColors position="top-center" />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/projects" element={<RequireFacilitator><Projects /></RequireFacilitator>} />
        <Route path="/projects/:id" element={<RequireFacilitator><ProjectDetail /></RequireFacilitator>} />
        <Route path="/projects/:id/review" element={<RequireAuth><Review /></RequireAuth>} />
        <Route path="/projects/:id/results" element={<RequireFacilitator><Results /></RequireFacilitator>} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
