import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { compactNumber, formatPct, relativeTime } from '../format'
import type { ActivityView } from '../types'
import { tileAccentColor } from '../tileAccent'
import { EmojiGlyph } from './EmojiGlyph'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
  cta?: ReactNode
}

export function ActivityInfo({ activity: a, now, cta }: Props) {
  const run = a.current_run
  const accent = useMemo(() => tileAccentColor(a.title), [a.title])
  const action = cta !== undefined
    ? cta
    : (
      <Link className="activity-launch primary" to={`/${a.code}`}>
        Join activity
      </Link>
    )
  return (
    <div className="activity-info">
      <div className="info-grid">
        <div className="info-left">
          <div className="info-face" style={{ background: accent }}>
            <span className="info-face-title">{a.title}</span>
            <span className="info-face-icon">
              <EmojiGlyph emoji={a.emoji} />
            </span>
          </div>
          <p className="info-location">{run?.location ?? 'Location TBD'}</p>
          {a.description && <p className="info-desc">{a.description}</p>}
        </div>
        <div className="info-right">
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
          {action}
        </div>
      </div>
      {run && <GroupMeter run={run} groupingMode={a.grouping_mode} />}
      <p className="tile-meta">
        proposed by {a.proposer_handle ?? 'someone'} · active {relativeTime(a.last_active_at, now)}
      </p>
    </div>
  )
}
