import { AnimatePresence } from 'framer-motion'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { HomeShell } from '../components/HomeShell'
import { PolicyPanel } from '../components/PolicyPanel'
import { ProposeForm } from '../components/ProposeForm'
import { requestNotificationPermission } from '../notify-client'
import { loadHomeRules, HOME_RULES_KEY, type PolicyRule } from '../policy/rules'
import { encodePolicySources } from '../policy/share'
import { writeJson } from '../storage'
import { useTheme } from '../theme'
import { Coachmark } from '../tutorial/Coachmark'
import { foldTutorialActivity, tutorialMe } from '../tutorial/fakeRoom'
import { useScript } from '../tutorial/useScript'
import { Spotlight } from '../tutorial/Spotlight'

const STEPS = [
  'welcome',
  'controls',
  'browser',
  'add-activity',
  'tile',
] as const

const CATEGORY_OPTIONS = [
  { value: 'board game', label: 'Board Game', count: 0 },
  { value: 'video game', label: 'Video Game', count: 0 },
] as const

export function HomeTour() {
  const navigate = useNavigate()
  const me = useMemo(() => tutorialMe(), [])
  const { theme, toggleTheme } = useTheme()
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [expanded, setExpanded] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showPolicyPanel, setShowPolicyPanel] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState('')
  const [rules, setRules] = useState<PolicyRule[]>(() => loadHomeRules())
  const script = useScript([...STEPS])
  const now = Date.now()
  const activity = foldTutorialActivity(now, [])

  const saveRules = (nextRules: PolicyRule[]) => {
    setRules(nextRules)
    writeJson(HOME_RULES_KEY, nextRules)
  }

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
        body: <>Rename your user by clicking the username, click ◑ to change the theme, <span className="noto-emoji">🔔</span> for notifications, ? for help, and ↻ to refresh the page.</>,
      }
    }
    if (script.step === 'browser') {
      return {
        title: 'Browse Activities',
        body: 'You can filter by categories, and also switch between the grid and list views.',
      }
    }
    if (script.step === 'add-activity') {
      return {
        title: 'Add an Activity',
        body: 'Click the + tile to open the Add an Activity panel.',
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
        : script.step === 'add-activity'
          ? '.create-tile, .create-list-item'
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
        onOpenPolicy={() => setShowPolicyPanel(true)}
        onRefresh={() => window.location.reload()}
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
          <CreateTile view={view} onClick={() => setCreating(true)} />
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
      {showPolicyPanel && (
        <PolicyPanel
          rules={rules}
          onRulesChange={saveRules}
          onClose={() => setShowPolicyPanel(false)}
          hint="Rules in this tutorial are saved locally as a demo."
          notifyStatus={notifyStatus}
          onRequestNotifications={() => {
            void requestNotificationPermission().then(setNotifyStatus)
          }}
          onShare={() => {
            const url = `${window.location.origin}/fold?policy=${encodeURIComponent(encodePolicySources(rules))}`
            void navigator.clipboard.writeText(url)
          }}
        />
      )}
      {creating && (
        <div className="modal-backdrop modal-backdrop-lower" onClick={() => setCreating(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div
              onSubmitCapture={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
            >
              <ProposeForm
                categoryOptions={[...CATEGORY_OPTIONS]}
                onCreated={() => {
                  setCreating(false)
                }}
                onClose={() => setCreating(false)}
              />
            </div>
            <p className="small">Posting is disabled in the tutorial.</p>
          </div>
        </div>
      )}
    </>
  )
}
