import { AnimatePresence } from 'framer-motion'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { HomeShell } from '../components/HomeShell'
import { useTheme } from '../theme'
import { Coachmark } from '../tutorial/Coachmark'
import { foldTutorialActivity, tutorialMe } from '../tutorial/fakeRoom'
import { useScript } from '../tutorial/useScript'

const STEPS = ['welcome', 'controls', 'tile'] as const

export function HomeTour() {
  const navigate = useNavigate()
  const me = useMemo(() => tutorialMe(), [])
  const { theme, toggleTheme } = useTheme()
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [expanded, setExpanded] = useState(true)
  const script = useScript([...STEPS])
  const now = Date.now()
  const activity = foldTutorialActivity(now, [])

  const coach = (() => {
    if (script.step === 'welcome') {
      return {
        title: 'Welcome',
        body: 'This page teaches the homepage controls. You can rename yourself, toggle theme, set policy, refresh, and open help.',
      }
    }
    if (script.step === 'controls') {
      return {
        title: 'Homepage Buttons',
        body: 'Use ? for help, 🔔 for policy rules, and ↻ to refresh activity state.',
      }
    }
    return {
      title: 'Fold Tile',
      body: 'Open this tile and join /FOLD to practice node movement, ETA changes, and committing into a ready group.',
    }
  })()

  return (
    <>
      <HomeShell
        handleSlot={(
          <button type="button" className="me-handle" title="Click to rename">
            {me.handle}
          </button>
        )}
        theme={theme}
        onThemeToggle={toggleTheme}
        onOpenPolicy={() => {}}
        onRefresh={() => {}}
        onHelp={() => navigate('/fold')}
        categories={['board game', 'video game']}
        activeTag="all"
        onTagSelect={() => {}}
        view={view}
        sort="newest"
        onSortChange={() => {}}
        onViewChange={setView}
      >
        <div className="tile-grid" key="tour-grid">
          <CreateTile view={view} onClick={() => {}} />
          <AnimatePresence mode="popLayout">
            <ActivityTile
              key={activity.id}
              activity={activity}
              now={now}
              size={2}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              cta={(
                <div className="activity-actions">
                  <Link className="activity-launch primary" to="/FOLD">
                    Join activity
                  </Link>
                </div>
              )}
            />
          </AnimatePresence>
        </div>
      </HomeShell>
      <div className="tutorial-home-hud">
        <Coachmark
          title={coach.title}
          body={coach.body}
          onBack={script.back}
          showBack={script.index > 0}
          onNext={script.isLast ? () => navigate('/FOLD') : script.next}
          nextLabel={script.isLast ? 'Go to /FOLD' : 'Next'}
        />
      </div>
    </>
  )
}
