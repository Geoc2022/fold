import './App.css'
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'

const ActivityRoom = lazy(() => import('./pages/ActivityRoom').then((module) => ({ default: module.ActivityRoom })))
const PhysicsPage = lazy(() => import('./pages/PhysicsPage').then((module) => ({ default: module.PhysicsPage })))
const ChemistryPage = lazy(() => import('./pages/ChemistryPage').then((module) => ({ default: module.ChemistryPage })))
const BiologyPage = lazy(() => import('./pages/BiologyPage').then((module) => ({ default: module.BiologyPage })))
const MathPage = lazy(() => import('./pages/MathPage').then((module) => ({ default: module.MathPage })))
const EmojiLabPage = lazy(() => import('./pages/EmojiLabPage').then((module) => ({ default: module.EmojiLabPage })))
const HomeTour = lazy(() => import('./pages/HomeTour').then((module) => ({ default: module.HomeTour })))
const RoomTutorial = lazy(() => import('./pages/RoomTutorial').then((module) => ({ default: module.RoomTutorial })))

export default function App() {
  return (
    <AppErrorBoundary>
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/physics" element={<PhysicsPage />} />
          <Route path="/chemistry" element={<ChemistryPage />} />
          <Route path="/biology" element={<BiologyPage />} />
          <Route path="/math" element={<MathPage />} />
          <Route path="/emoji-lab" element={<EmojiLabPage />} />
          <Route path="/fold" element={<HomeTour />} caseSensitive />
          <Route path="/FOLD" element={<RoomTutorial />} caseSensitive />
          <Route path="/:code" element={<ActivityRoom />} />
          <Route
            path="*"
            element={
              <main className="shell">
                <h1>Fold</h1>
                <p className="pending">That page does not exist.</p>
              </main>
            }
          />
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  )
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[fold:ui] render_failed', error, info)
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="shell">
          <h1>Fold</h1>
          <p className="pending">The page could not finish loading.</p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>Try again</button>
        </main>
      )
    }
    return this.props.children
  }
}

function PageLoading() {
  return (
    <main className="shell" aria-live="polite">
      <h1>Fold</h1>
      <p className="pending">Opening...</p>
    </main>
  )
}
