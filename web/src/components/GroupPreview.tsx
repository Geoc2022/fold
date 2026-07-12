import { useMemo, useState } from 'react'
import type { GroupingMode } from '../types'
import { sampleGroupPreview } from '../grouping'

interface Props {
  mode: GroupingMode
  min: number
  max: number | null
  groupMultiple: number
}

/** Live "what might a group look like" preview for the propose form, per
 * src/logic.rs's group-state rules. Blocks impossible configs outright. */
export function GroupPreview({ mode, min, max, groupMultiple }: Props) {
  const [seed, setSeed] = useState(0)
  const preview = useMemo(
    () => sampleGroupPreview(mode, min, max, groupMultiple),
    [mode, min, max, groupMultiple, seed],
  )

  if (!preview.feasible) {
    return (
      <div className="group-preview infeasible">
        <p className="err">
          This min/max/group-size combination can never form a complete group
          {mode === 'tiling' ? ` of ${groupMultiple}` : ''}. Widen the range or change the group size.
        </p>
      </div>
    )
  }

  return (
    <div className="group-preview">
      <div className="preview-dots">
        {preview.groupSizes.map((size, gi) => (
          <span className="meter-group" key={gi}>
            {Array.from({ length: size }).map((_, i) => (
              <span className="dot filled" key={i} />
            ))}
          </span>
        ))}
        {preview.waiting > 0 && (
          <span className="meter-group waiting">
            {Array.from({ length: preview.waiting }).map((_, i) => (
              <span className="dot waiting" key={i} />
            ))}
          </span>
        )}
      </div>
      <button type="button" className="preview-caption hint" onClick={() => setSeed((s) => s + 1)}>
        if {preview.sampleTotal} committed:{' '}
        {mode === 'tiling'
          ? `${preview.groupSizes.length} group${preview.groupSizes.length === 1 ? '' : 's'} of ${groupMultiple}`
          : `1 group of ${preview.groupSizes[0] ?? 0}`}{' '}
        <span aria-hidden="true">↻</span>
      </button>
    </div>
  )
}
