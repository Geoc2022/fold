import type { ActivityView } from '../types'

export function policyCommitEta(
  activity: Pick<ActivityView, 'max_commit_seconds' | 'my_state' | 'my_arrival_at'>,
  etaDeltaSeconds: number | null,
  now: number,
): number {
  const maxEta = Math.max(0, activity.max_commit_seconds)
  const defaultEta = Math.min(maxEta, 30 * 60)
  if (etaDeltaSeconds == null) return defaultEta
  const currentEta = activity.my_state === 'committed' && activity.my_arrival_at != null
    ? Math.max(0, Math.ceil((activity.my_arrival_at - now) / 1000))
    : defaultEta
  return Math.max(0, Math.min(maxEta, currentEta + etaDeltaSeconds))
}
