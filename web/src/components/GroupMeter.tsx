import type { ActivityView } from '../types'

/** Visualizes committed people as filled dots grouped into complete groups. */
export function GroupMeter({ activity }: { activity: ActivityView }) {
  const { group, committed_count, grouping_mode } = activity
  const inGroups = group.group_sizes.reduce((a, b) => a + b, 0)
  const waiting = group.waiting_count

  return (
    <div className="meter">
      <div className="meter-dots">
        {group.group_sizes.map((size, gi) => (
          <span className="meter-group" key={gi} title={`Group of ${size}`}>
            {Array.from({ length: size }).map((_, i) => (
              <span className="dot filled" key={i} />
            ))}
          </span>
        ))}
        {waiting > 0 && (
          <span className="meter-group waiting" title="Waiting to link up">
            {Array.from({ length: waiting }).map((_, i) => (
              <span className="dot waiting" key={i} />
            ))}
          </span>
        )}
        {inGroups + waiting === 0 && <span className="dot empty" />}
      </div>
      <div className="meter-label">
        {group.is_ready ? (
          <span className="ready-text">
            {group.complete_groups}{' '}
            {grouping_mode === 'tiling'
              ? group.complete_groups === 1
                ? 'group'
                : 'groups'
              : 'group'}{' '}
            ready · {committed_count} committed
          </span>
        ) : group.spots_to_next != null ? (
          <span>
            {group.spots_to_next} more to {committed_count > 0 ? 'form a group' : 'get started'}
          </span>
        ) : (
          <span>full</span>
        )}
      </div>
    </div>
  )
}
