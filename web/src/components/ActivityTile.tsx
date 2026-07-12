import { useState } from 'react'
import { Link } from 'react-router-dom'
import { compactNumber, formatPct, relativeTime, titleCase } from '../format'
import type { ActivityView } from '../types'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
}

const RUN_HINT: Record<string, string> = {
  ready: 'ready to go',
  scheduled: 'scheduled',
  closed: 'wrapped up',
  cancelled: 'cancelled',
}

/** Grid tile: collapsed shows emoji/title/category; expands (click) into a
 * Stack-Exchange-style stats panel with a Launch button. */
export function ActivityTile({ activity: a, now }: Props) {
  const [expanded, setExpanded] = useState(false)
  const run = a.current_run

  return (
    <article className={`tile ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="tile-face"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tile-emoji">{a.emoji}</span>
        <span className="tile-title">{a.title}</span>
        <span className="tag-pill sm">{titleCase(a.category)}</span>
        {run ? (
          <span className={`tile-run-hint run-${run.status}`}>
            {RUN_HINT[run.status] ?? `${run.committed_count} committed`}
          </span>
        ) : (
          <span className="tile-run-hint run-empty">room is empty</span>
        )}
      </button>
      {expanded && (
        <div className="tile-expanded">
          {a.description && <p className="tile-desc">{a.description}</p>}
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
          {run && <GroupMeter run={run} groupingMode={a.grouping_mode} />}
          <p className="tile-meta">
            proposed by {a.proposer_handle ?? 'someone'} · active {relativeTime(a.last_active_at, now)}
          </p>
          <Link className="tile-launch primary" to={`/${a.code}`}>
            Launch
          </Link>
        </div>
      )}
    </article>
  )
}
