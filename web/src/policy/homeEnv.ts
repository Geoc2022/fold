import type { ActivityView } from '../types'
import type { JsonValue, PolicyValue } from './engine'
import { bool, dur, envFromVars, list, num, record, str, variant } from './values'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Build the policy environment for one activity as seen from the home
 * page. Unlike the room page, the home page only has aggregate counts (no
 * participant list), so `interested`/`committed` are synthesized lists of
 * anonymous people sized to match those counts -- enough for policies that
 * count or check readiness, though per-person detail (name, exact ETA) isn't
 * available here. */
export function buildActivityPolicyEnv(activity: ActivityView, serverTime: number): JsonValue {
  const run = activity.current_run
  const group = run?.group ?? null
  const interestedCount = run?.interested_count ?? 0
  const committedCount = run?.committed_count ?? 0

  const selfEta =
    activity.my_arrival_at != null ? Math.max(0, Math.ceil((activity.my_arrival_at - serverTime) / 1000)) : 0
  const selfPerson = personPlaceholder(
    activity.my_state === 'committed' ? 'committed' : activity.my_state === 'interested' ? 'interested' : 'lurker',
    selfEta,
  )

  const now = new Date(serverTime)

  const vars: Record<string, PolicyValue> = {
    self: selfPerson,
    interested: list(times(interestedCount, () => personPlaceholder('interested', 0))),
    committed: list(times(committedCount, () => personPlaceholder('committed', 0))),
    arrived: list([]),
    lurkers: list([]),
    today: variant('Day', DAY_NAMES[now.getDay()], []),
    now: record('Time', { hour: num(now.getHours()), minute: num(now.getMinutes()) }),
    min_people: num(activity.min_people),
    max_people: activity.max_people != null ? variant('Option', 'Some', [num(activity.max_people)]) : variant('Option', 'None', []),
    group_size: num(activity.group_multiple),
    grouping_mode: variant('Grouping', activity.grouping_mode === 'tiling' ? 'Parallel' : 'Single', []),
    duration: dur(activity.duration_seconds),
    max_commit: dur(activity.max_commit_seconds),
    groups_ready: num(group?.complete_groups ?? 0),
    waiting_count: num(group?.waiting_count ?? 0),
    spots_to_next: num(group?.spots_to_next ?? 0),
    is_ready: bool(group?.is_ready ?? false),
    // Per-person ETAs aren't available at the home-page level, so a
    // predicted ready time can't be computed here.
    ready_in: variant('Option', 'None', []),
    title: str(activity.title),
    code: str(activity.code),
  }
  return envFromVars(vars)
}

export const buildHomePolicyEnv = buildActivityPolicyEnv

function times<T>(n: number, fn: () => T): T[] {
  return Array.from({ length: Math.max(0, n) }, fn)
}

function personPlaceholder(state: 'lurker' | 'interested' | 'committed', etaSecs: number): PolicyValue {
  const st =
    state === 'committed'
      ? variant('State', 'Committed', [dur(etaSecs)])
      : state === 'interested'
        ? variant('State', 'Interested', [])
        : variant('State', 'Lurker', [])
  return record('Person', { name: str(''), state: st, engaged_for: dur(0) })
}
