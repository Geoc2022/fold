import { memo } from 'react'
import type { ActivityView } from '../types'
import { tileAccentColor } from '../tileAccent'
import type { PresenceBadgeModel } from '../activityPresence'
import { PresenceBadge } from './PresenceBadge'

type Variant = 'card' | 'square'
type Size = 1 | 2 | 3

interface Props {
  activity: Pick<ActivityView, 'title' | 'emoji'>
  variant?: Variant
  onClick?: () => void
  ariaExpanded?: boolean
  size?: Size
  presenceBadge?: PresenceBadgeModel | null
}

export const ActivityBadge = memo(function ActivityBadge({ activity, variant = 'card', onClick, ariaExpanded, size = 1, presenceBadge = null }: Props) {
  const accent = tileAccentColor(activity.title)
  const variantClass = variant === 'square' ? 'square' : 'card'
  const className = `activity-badge ${variantClass} size-${size}`
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={className}
      style={{ background: accent }}
      onClick={onClick}
      aria-expanded={ariaExpanded}
    >
      {presenceBadge && <PresenceBadge model={presenceBadge} />}
      <span className="activity-badge-title">{activity.title}</span>
      <span className="activity-badge-emoji noto-emoji" aria-hidden="true">
        {activity.emoji}
      </span>
    </Tag>
  )
})
