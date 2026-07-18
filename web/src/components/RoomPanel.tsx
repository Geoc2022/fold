import { Link } from 'react-router-dom'
import type { ActivityView } from '../types'

interface Props {
  activity: ActivityView
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  onInfo: () => void
  onProposeRun: () => void
  onOpenPolicy: () => void
}

export function RoomPanel({ activity, theme, onThemeToggle, onInfo, onProposeRun, onOpenPolicy }: Props) {

  return (
    <div className="global-panel">
      <button className="panel-button icon" onClick={onThemeToggle} title="Toggle theme">
        {theme === 'light' ? '◐' : '◑'}
      </button>
      {!activity.current_run && (
        <button className="panel-button" onClick={onProposeRun}>Propose a run</button>
      )}
      <div className="panel-separator" />
      <button className="panel-button icon noto-emoji" onClick={() => { window.location.href = '/' }} title="Back home">🏠</button>
      <button className="panel-button icon noto-emoji" onClick={onOpenPolicy} title="Notification policy">🔔</button>
      <button className="panel-button icon" onClick={onInfo} title="Room info">ℹ︎</button>
      <Link className="panel-button icon" to="/FOLD" title="Help">?</Link>
    </div>
  )
}
