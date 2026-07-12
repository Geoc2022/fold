import { motion } from 'framer-motion'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { nordColorForEmoji } from '../emojiColor'
import { compactNumber, formatPct, relativeTime } from '../format'
import type { ActivityView } from '../types'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
  size: 1 | 2 | 3
}

/** Grid tile: collapsed shows just title + emoji, sized (1x1/2x2/3x3 units)
 * by popularity. Click expands to a fixed 3x2 stats panel with Launch. */
export function ActivityTile({ activity: a, now, size }: Props) {
  const [expanded, setExpanded] = useState(false)
  const run = a.current_run
  const accent = useMemo(() => nordColorForEmoji(a.emoji), [a.emoji])

  const colSpan = expanded ? 3 : size
  const rowSpan = expanded ? 2 : size

  return (
    <motion.article
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className={`tile size-${size} ${expanded ? 'expanded' : ''}`}
      style={{ gridColumn: `span ${colSpan}`, gridRow: `span ${rowSpan}`, '--tile-accent': accent } as React.CSSProperties}
    >
      <button
        type="button"
        className="tile-face"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tile-title">{a.title}</span>
        <span className="tile-emoji">{a.emoji}</span>
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
    </motion.article>
  )
}
