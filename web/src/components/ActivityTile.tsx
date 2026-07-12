import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { compactNumber, formatPct, relativeTime } from '../format'
import { tileAccentColor } from '../tileAccent'
import type { ActivityView } from '../types'
import { EmojiGlyph } from './EmojiGlyph'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  now: number
  size: 1 | 2 | 3
  expanded: boolean
  onToggle: () => void
}

/** Grid tile: collapsed is a solid-color square (title + icon, sized
 * 1x1/2x2/3x3 units by popularity). Click expands to a fixed 4x3 stats
 * panel with Launch. Only one tile can be expanded at a time (controlled by
 * the parent). */
export function ActivityTile({ activity: a, now, size, expanded, onToggle }: Props) {
  const run = a.current_run
  const accent = useMemo(() => tileAccentColor(a.title), [a.title])

  const colSpan = expanded ? 4 : size
  const rowSpan = expanded ? 3 : size

  return (
    <motion.article
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className={`tile size-${size} ${expanded ? 'expanded' : ''}`}
      style={{ gridColumn: `span ${colSpan}`, gridRow: `span ${rowSpan}` }}
    >
      <button
        type="button"
        className="tile-face"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{ background: accent }}
      >
        <span className="tile-title">{a.title}</span>
        <span className="tile-icon-box">
          <EmojiGlyph emoji={a.emoji} className="tile-emoji" />
        </span>
      </button>
      {expanded && (
        <div className="tile-expanded">
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
            <Link className="tile-launch primary" to={`/${a.code}`}>
              Launch
            </Link>
          </div>
          {run && <GroupMeter run={run} groupingMode={a.grouping_mode} />}
          <p className="tile-meta">
            proposed by {a.proposer_handle ?? 'someone'} · active {relativeTime(a.last_active_at, now)}
          </p>
        </div>
      )}
    </motion.article>
  )
}
