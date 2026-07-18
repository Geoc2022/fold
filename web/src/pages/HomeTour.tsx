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
import { Spotlight } from '../tutorial/Spotlight'

const STEPS = ['welcome', 'controls', 'browser', 'tile'] as const

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
        title: 'Welcome to Fold!',
        body: 'This page teaches the homepage controls. You can can always come back to this page by clicking the question mark at the top right or going to this page (/fold)',
      }
    }
    if (script.step === 'controls') {
      return {
        title: 'Homepage Buttons',
        body: <>Rename your user by clicking the username, click ◑ to change the theme, <span className="noto-emoji">🔔</span> for policy rules, ? for help, and ↻ to refresh the page.</>,
      }
    }
    if (script.step === 'browser') {
      return {
        title: 'Browse Activities',
        body: 'You can filter by categories, and also switch between the grid and list views.',
      }
    }
    return {
      title: 'Fold Tile',
      body: 'You can expand tiles to get their stats by clicking them. Click "Join activity" /FOLD to practice joining a room',
    }
  })()
  const spotlightTarget = script.step === 'welcome'
    ? '.topbar .brand'
    : script.step === 'controls'
      ? '.topbar .me'
      : script.step === 'browser'
        ? '.browser-controls'
        : '.tile.expanded'

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
      <Spotlight target={spotlightTarget} />
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
