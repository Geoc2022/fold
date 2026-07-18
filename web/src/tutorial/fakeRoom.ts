import type { ActivityView, GroupState, ParticipantView, Person } from '../types'

const NOW = Date.now()

export function tutorialMe(): Person {
  return {
    id: 'tutorial-me',
    handle: 'guest#0000',
    color: '#1f2937',
    created_at: NOW,
    last_seen_at: NOW,
  }
}

export function tutorialParticipant(id: string, state: 'interested' | 'committed', now: number): ParticipantView {
  return {
    id,
    color: '#64748b',
    state,
    arrival_at: state === 'committed' ? now + 20_000 : null,
    is_me: false,
    last_seen_at: now,
  }
}

export function foldTutorialActivity(now: number, participants: ParticipantView[]): ActivityView {
  const runId = 'tutorial-run'
  const committed = participants.filter((p) => p.state === 'committed').length
  const interested = participants.filter((p) => p.state === 'interested').length
  const group = computeGroupState('single', 5, null, 1, committed)

  return {
    id: 'tutorial-fold',
    code: 'FOLD',
    emoji: 'ツ',
    title: 'Fold',
    description: 'Bringing people into the fold',
    category: 'board game',
    proposer_id: 'tutorial-proposer',
    proposer_handle: 'fold',
    min_people: 5,
    max_people: null,
    group_multiple: 1,
    grouping_mode: 'single',
    allow_guests: true,
    private_by_link: false,
    duration_seconds: 12 * 60 * 60,
    max_commit_seconds: 30,
    times_run: 0,
    players_served: 0,
    interest_total: 0,
    commit_total: 0,
    commit_pct: null,
    last_active_at: now,
    created_at: now,
    updated_at: now,
    current_run: {
      id: runId,
      status: 'open',
      location: null,
      details: null,
      scheduled_for: null,
      expires_at: null,
      interested_count: interested,
      committed_count: committed,
      created_at: now,
      updated_at: now,
      group,
    },
    my_state: participants.find((p) => p.is_me)?.state ?? null,
    my_arrival_at: participants.find((p) => p.is_me)?.arrival_at ?? null,
  }
}

function computeGroupState(
  mode: 'single' | 'tiling',
  minPeople: number,
  maxPeople: number | null,
  groupMultiple: number,
  committed: number,
): GroupState {
  const step = Math.max(1, groupMultiple)
  const min = Math.max(1, minPeople)
  const cap = maxPeople ?? Number.MAX_SAFE_INTEGER

  if (committed < min) {
    return {
      complete_groups: 0,
      group_sizes: [],
      is_ready: false,
      waiting_count: committed,
      spots_to_next: min - committed,
      spots_remaining: maxPeople == null ? null : Math.max(0, maxPeople - committed),
    }
  }

  if (mode === 'single') {
    const usable = Math.min(committed, cap)
    const playable = min + Math.floor((usable - min) / step) * step
    const waiting = committed - playable
    const nextSize = playable + step
    return {
      complete_groups: 1,
      group_sizes: [playable],
      is_ready: true,
      waiting_count: waiting,
      spots_to_next: nextSize <= cap ? nextSize - committed : null,
      spots_remaining: maxPeople == null ? null : Math.max(0, maxPeople - committed),
    }
  }

  const groupSize = step
  const usable = Math.min(committed, cap)
  const groups = Math.floor(usable / groupSize)
  const placed = groups * groupSize
  const waiting = committed - placed
  const nextTotal = placed + groupSize
  return {
    complete_groups: groups,
    group_sizes: Array.from({ length: groups }, () => groupSize),
    is_ready: groups >= 1,
    waiting_count: waiting,
    spots_to_next: nextTotal <= cap ? groupSize - (usable - placed) : null,
    spots_remaining: maxPeople == null ? null : Math.max(0, maxPeople - committed),
  }
}
