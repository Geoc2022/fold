import { motion } from 'framer-motion'
import type { ActivityView } from '../types'
import { ActivityBadge } from './ActivityBadge'
import { ActivityInfo } from './ActivityInfo'

interface Props {
  activity: ActivityView
  now: number
  size: 1 | 2 | 3
  expanded: boolean
  onToggle: () => void
}

/** Grid tile: collapsed is a solid-color square (title + icon, sized
 * 1x1/2x2/3x3 units by popularity). Click expands to a fixed 4x3 stats
 * panel with Join. Only one tile can be expanded at a time (controlled by
 * the parent). */
export function ActivityTile({ activity: a, now, size, expanded, onToggle }: Props) {
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
      {!expanded && <ActivityBadge activity={a} variant="card" size={size} onClick={onToggle} ariaExpanded={expanded} />}
      {expanded && (
        <div className="tile-expanded">
          <ActivityInfo activity={a} now={now} />
        </div>
      )}
    </motion.article>
  )
}
