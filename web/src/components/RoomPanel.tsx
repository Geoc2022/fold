import { enablePushNotifications } from '../push-client'
import type { ActivityView } from '../types'

interface Props {
  activity: ActivityView
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  onInfo: () => void
  onProposeRun: () => void
  onAlert: (message: string) => void
}

const HELP_URL = 'https://github.com/CHANGE_ME/fold'

export function RoomPanel({ activity, theme, onThemeToggle, onInfo, onProposeRun, onAlert }: Props) {
  async function share() {
    const url = `${window.location.origin}/${activity.code}`
    try {
      if (navigator.share) await navigator.share({ title: activity.title, url })
      else await navigator.clipboard.writeText(url)
      onAlert('Link copied')
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  async function enablePush() {
    try {
      onAlert(await enablePushNotifications())
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="global-panel">
      <button className="panel-button icon" onClick={onThemeToggle} title="Toggle theme">
        {theme === 'light' ? '◐' : '◑'}
      </button>
      {!activity.current_run && (
        <button className="panel-button" onClick={onProposeRun}>Propose a run</button>
      )}
      <div className="panel-separator" />
      <button className="panel-button icon noto-emoji" onClick={share} title="Share">🔗</button>
      <button className="panel-button icon noto-emoji" onClick={enablePush} title="Notifications">🔔</button>
      <button className="panel-button icon" onClick={onInfo} title="Room info">ℹ︎</button>
      <a className="panel-button icon" href={HELP_URL} target="_blank" rel="noopener noreferrer" title="Help">?</a>
    </div>
  )
}
