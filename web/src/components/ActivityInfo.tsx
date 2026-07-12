import { Link } from 'react-router-dom'
import { compactNumber, formatPct, relativeTime } from '../format'
import type { ActivityView } from '../types'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
  showLaunch?: boolean
}

export function ActivityInfo({ activity: a, now, showLaunch = true }: Props) {
  const run = a.current_run
  return (
    <div className="activity-info">
      {a.description && <p className="tile-desc">{a.description}</p>}
      <div className="tile-stats-row">
        <table className="stats-table">
          <tbody>
            <tr>
              <th>runs</th>
              <td>{compactNumber(a.times_run)}</td>
            </tr>
            <tr>
              <th>served</th>
              <td>{compactNumber(a.players_served)}</td>
            </tr>
            <tr>
              <th>commit%</th>
              <td>{formatPct(a.commit_pct)}</td>
            </tr>
          </tbody>
        </table>
        {showLaunch && (
          <Link className="tile-launch primary" to={`/${a.code}`}>
            Launch
          </Link>
        )}
      </div>
      {run && <GroupMeter run={run} groupingMode={a.grouping_mode} />}
      <p className="tile-meta">
        proposed by {a.proposer_handle ?? 'someone'} · active {relativeTime(a.last_active_at, now)}
      </p>
    </div>
  )
}
