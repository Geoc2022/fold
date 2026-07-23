import type { ActivityView, ParticipantView } from './types'
import { visualState, type VisualNodeState } from './nodeVisual'

export interface PresenceBadgeModel {
  user: VisualNodeState
  other: VisualNodeState | null
  center: 'user' | 'other'
}

const RANK: Record<VisualNodeState, number> = {
  lurker: 0,
  interested: 1,
  committed: 2,
  arrived: 3,
}

export function myActivityPresenceState(activity: ActivityView, now: number): VisualNodeState {
  if (!activity.my_state) return 'lurker'
  return visualState({ state: activity.my_state, arrival_at: activity.my_arrival_at ?? null }, now)
}

export function activityPresenceBadgeModel(activity: ActivityView, now: number, participants?: ParticipantView[]): PresenceBadgeModel | null {
  if (!activity.current_run) return null

  const user = myActivityPresenceState(activity, now)
  let other: VisualNodeState | null = null
  if (participants && participants.length > 0) {
    const counts: Record<VisualNodeState, number> = { lurker: 0, interested: 0, committed: 0, arrived: 0 }
    for (const participant of participants) {
      if (participant.is_me) continue
      counts[visualState(participant, now)] += 1
    }
    other = pickDominantState(counts)
  } else {
    const run = activity.current_run
    const othersInterested = Math.max(0, run.interested_count - (user === 'interested' ? 1 : 0))
    const othersCommitted = Math.max(0, run.committed_count - ((activity.my_state === 'committed') ? 1 : 0))
    if (othersCommitted > othersInterested) other = 'committed'
    else if (othersInterested > othersCommitted) other = 'interested'
    else if (othersCommitted > 0) other = 'committed'
  }

  if (!other) {
    return { user, other: null, center: 'user' }
  }

  let center: 'user' | 'other' = 'user'
  if (user === 'arrived') center = 'user'
  else if (other === 'arrived') center = 'other'
  else if (RANK[other] > RANK[user]) center = 'other'

  return { user, other, center }
}

function pickDominantState(counts: Record<VisualNodeState, number>): VisualNodeState | null {
  let winner: VisualNodeState | null = null
  let max = 0
  for (const state of ['arrived', 'committed', 'interested', 'lurker'] as const) {
    const count = counts[state]
    if (count > max) {
      max = count
      winner = state
    }
  }
  return winner
}
