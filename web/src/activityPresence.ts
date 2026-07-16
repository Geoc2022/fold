import type { ActivityView } from './types'
import { visualState, type VisualNodeState } from './nodeVisual'

export function myActivityPresenceState(activity: ActivityView, now: number): VisualNodeState | null {
  if (!activity.my_state) return null
  return visualState({ state: activity.my_state, arrival_at: activity.my_arrival_at ?? null }, now)
}
