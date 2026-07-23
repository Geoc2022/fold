import { memo } from 'react'
import type { PresenceBadgeModel } from '../activityPresence'

interface Props {
  model: PresenceBadgeModel
}

export const PresenceBadge = memo(function PresenceBadge({ model }: Props) {
  const showOther = model.other != null
  const userAtCenter = model.center === 'user'
  return (
    <span className="presence-badge" aria-hidden="true">
      {showOther && (
        <span
          className={`presence-node state-${model.other} role-other ${userAtCenter ? 'pos-offset' : 'pos-center'}`}
        />
      )}
      <span
        className={`presence-node state-${model.user} role-user ${showOther ? (userAtCenter ? 'pos-center' : 'pos-offset') : (model.user === 'arrived' ? 'pos-center' : 'pos-offset')}`}
      />
    </span>
  )
})
