// Client-side mirror of src/logic.rs. Lets the propose form validate and
// preview a grouping configuration before it ever hits the server.

import type { GroupingMode } from './types'

/** Mirrors `grouping_is_feasible` in src/logic.rs. */
export function groupingIsFeasible(
  mode: GroupingMode,
  minPeople: number,
  maxPeople: number | null,
  groupMultiple: number,
): boolean {
  const min = Math.max(1, minPeople)
  const step = Math.max(1, groupMultiple)
  if (mode === 'single') {
    return maxPeople == null || min <= maxPeople
  }
  // Tiling groups only ever form in multiples of `step`, so min (and max,
  // if capped) must themselves be clean multiples of it.
  if (min % step !== 0) return false
  if (maxPeople != null && maxPeople % step !== 0) return false
  const needed = Math.max(min, step)
  return maxPeople == null || needed <= maxPeople
}

export interface GroupPreviewResult {
  feasible: boolean
  sampleTotal: number
  groupSizes: number[]
  waiting: number
}

/**
 * Pick a random plausible committed count in [min, max] and derive what the
 * resulting group(s) would look like -- mirrors `compute_group_state` in
 * src/logic.rs, used purely for the propose-form live preview.
 */
export function sampleGroupPreview(
  mode: GroupingMode,
  minPeople: number,
  maxPeople: number | null,
  groupMultiple: number,
): GroupPreviewResult {
  const min = Math.max(1, minPeople)
  const step = Math.max(1, groupMultiple)
  if (!groupingIsFeasible(mode, min, maxPeople, step)) {
    return { feasible: false, sampleTotal: 0, groupSizes: [], waiting: 0 }
  }

  const ceiling = maxPeople ?? Math.max(min, step) * 3 + min
  const total = min + Math.floor(Math.random() * (ceiling - min + 1))
  const usable = Math.min(total, maxPeople ?? total)

  if (mode === 'single') {
    const playable = min + Math.floor((usable - min) / step) * step
    return { feasible: true, sampleTotal: total, groupSizes: [playable], waiting: total - playable }
  }

  const groups = Math.floor(usable / step)
  if (groups < 1) {
    // The random sample landed below one full group; show the smallest
    // feasible total instead so the preview always demonstrates a real group.
    const flooredTotal = Math.max(min, step)
    const flooredGroups = Math.max(1, Math.floor(flooredTotal / step))
    return {
      feasible: true,
      sampleTotal: flooredTotal,
      groupSizes: Array.from({ length: flooredGroups }, () => step),
      waiting: flooredTotal % step,
    }
  }
  return {
    feasible: true,
    sampleTotal: total,
    groupSizes: Array.from({ length: groups }, () => step),
    waiting: usable - groups * step,
  }
}
