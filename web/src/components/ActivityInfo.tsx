import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { relativeTime } from '../format'
import type { ActivityView } from '../types'
import { ActivityBadge } from './ActivityBadge'
import { ActivityStats } from './ActivityStats'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
  cta?: ReactNode
}

export function ActivityInfo({ activity: a, now, cta }: Props) {
  const run = a.current_run
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
          <ActivityBadge activity={a} variant="square" />
          <p className="info-location">{run?.location ?? 'Location TBD'}</p>
          {a.description && <p className="info-desc">{a.description}</p>}
        </div>
        <div className="info-right">
          <ActivityStats activity={a} />
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
