import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { compactNumber, formatPct } from '../format'
import type { ActivityView } from '../types'

interface Props {
  activity: ActivityView
}

/** List-view row: SE's lv-item, with our stats swapped in for theirs. */
export function ActivityListItem({ activity: a }: Props) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="list-item"
    >
      <span className="list-emoji">{a.emoji}</span>
      <div className="list-info">
        <h3>{a.title}</h3>
        {a.description && <p className="list-desc">{a.description}</p>}
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
    </motion.div>
  )
}
