import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import type { ActivityView } from '../types'
import { EmojiGlyph } from './EmojiGlyph'
import { ActivityStats } from './ActivityStats'
import { myActivityPresenceState } from '../activityPresence'

interface Props {
  activity: ActivityView
  now: number
  canEdit?: boolean
  onEdit?: () => void
}

/** List-view row: SE's lv-item, with our stats swapped in for theirs. */
export function ActivityListItem({ activity: a, now, canEdit = false, onEdit }: Props) {
  const presenceState = myActivityPresenceState(a, now)
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="list-item"
    >
      {presenceState && <span className={`activity-state-dot state-${presenceState}`} aria-hidden="true" />}
      <EmojiGlyph emoji={a.emoji} className="list-emoji" />
      <div className="list-info">
        <h3>{a.title}</h3>
        {a.description && <p className="list-desc">{a.description}</p>}
      </div>
      <div className="list-stats">
        <ActivityStats activity={a} variant="pill" />
      </div>
      <div className="list-actions">
        <Link className="list-launch primary sm" to={`/${a.code}`}>
          Join
        </Link>
        {canEdit && (
          <button type="button" className="list-launch ghost sm" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
    </motion.div>
  )
}
