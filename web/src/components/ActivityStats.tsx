import type { ActivityView } from '../types'
import { compactNumber, formatPct } from '../format'

interface Props {
  activity: Pick<ActivityView, 'times_run' | 'players_served' | 'commit_pct'>
  variant?: 'table' | 'pill'
}

export function ActivityStats({ activity, variant = 'table' }: Props) {
  if (variant === 'pill') {
    return (
      <div className="activity-stats-pill">
        <div className="stat-box">
          <span className="stat-num">{compactNumber(activity.times_run)}</span> runs
        </div>
        <div className="stat-box">
          <span className="stat-num">{compactNumber(activity.players_served)}</span> served
        </div>
        <div className="stat-box">
          <span className="stat-num">{formatPct(activity.commit_pct)}</span> commit
        </div>
      </div>
    )
  }
  return (
    <table className="stats-table">
      <tbody>
        <tr>
          <th>runs</th>
          <td>{compactNumber(activity.times_run)}</td>
        </tr>
        <tr>
          <th>served</th>
          <td>{compactNumber(activity.players_served)}</td>
        </tr>
        <tr>
          <th>commit%</th>
          <td>{formatPct(activity.commit_pct)}</td>
        </tr>
      </tbody>
    </table>
  )
}
