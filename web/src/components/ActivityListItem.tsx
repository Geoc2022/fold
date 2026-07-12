import { Link } from 'react-router-dom'
import { compactNumber, formatPct, titleCase } from '../format'
import type { ActivityView } from '../types'

interface Props {
  activity: ActivityView
}

/** List-view row: SE's lv-item, with our stats swapped in for theirs. */
export function ActivityListItem({ activity: a }: Props) {
  return (
    <div className="list-item">
      <span className="list-emoji">{a.emoji}</span>
      <div className="list-info">
        <h3>{a.title}</h3>
        {a.description && <p className="list-desc">{a.description}</p>}
        <span className="tag-pill sm">{titleCase(a.category)}</span>
      </div>
      <div className="list-stats">
        <div className="stat-box">
          <span className="stat-num">{compactNumber(a.times_run)}</span> runs
        </div>
        <div className="stat-box">
          <span className="stat-num">{compactNumber(a.players_served)}</span> served
        </div>
        <div className="stat-box">
          <span className="stat-num">{formatPct(a.commit_pct)}</span> commit
        </div>
      </div>
      <Link className="list-launch primary sm" to={`/${a.code}`}>
        Launch
      </Link>
    </div>
  )
}
