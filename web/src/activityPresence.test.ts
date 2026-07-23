import { describe, expect, it } from 'vitest'
import { activityPresenceBadgeModel } from './activityPresence'
import type { ActivityView, ParticipantView } from './types'

function activity(overrides: Partial<ActivityView>): ActivityView {
  return {
    id: 'a1',
    code: 'TEST',
    emoji: 'x',
    title: 'Test',
    description: null,
    category: 'misc',
    proposer_id: 'p1',
    proposer_handle: null,
    min_people: 2,
    max_people: null,
    group_multiple: 1,
    grouping_mode: 'single',
    allow_guests: true,
    private_by_link: false,
    duration_seconds: 1800,
    max_commit_seconds: 1800,
    times_run: 0,
    players_served: 0,
    interest_total: 0,
    commit_total: 0,
    commit_pct: null,
    last_active_at: 0,
    created_at: 0,
    updated_at: 0,
    current_run: {
      id: 'r1',
      status: 'open',
      location: null,
      details: null,
      scheduled_for: null,
      expires_at: null,
      interested_count: 0,
      committed_count: 0,
      created_at: 0,
      updated_at: 0,
      group: {
        complete_groups: 0,
        group_sizes: [],
        is_ready: false,
        waiting_count: 0,
        spots_to_next: null,
        spots_remaining: null,
      },
    },
    my_state: null,
    my_arrival_at: null,
    ...overrides,
  }
}

describe('activityPresenceBadgeModel', () => {
  it('shows lurker as an off-center single node in an active room', () => {
    const model = activityPresenceBadgeModel(activity({ my_state: null }), 100)
    expect(model).toEqual({ user: 'lurker', other: null, center: 'user' })
  })

  it('keeps arrived user centered above committed-majority others', () => {
    const now = 500
    const model = activityPresenceBadgeModel(activity({
      my_state: 'committed',
      my_arrival_at: now - 1,
      current_run: {
        ...activity({}).current_run!,
        interested_count: 0,
        committed_count: 3,
      },
    }), now)
    expect(model).toEqual({ user: 'arrived', other: 'committed', center: 'user' })
  })

  it('centers committed when it outranks interested in a tie', () => {
    const model = activityPresenceBadgeModel(activity({
      my_state: 'interested',
      current_run: {
        ...activity({}).current_run!,
        interested_count: 2,
        committed_count: 1,
      },
    }), 0)
    expect(model).toEqual({ user: 'interested', other: 'committed', center: 'other' })
  })

  it('uses participant-level arrived majority when available', () => {
    const now = 1_000
    const participants: ParticipantView[] = [
      { id: 'me', color: '', state: 'committed', arrival_at: now + 60_000, is_me: true, last_seen_at: now },
      { id: 'a', color: '', state: 'committed', arrival_at: now - 100, is_me: false, last_seen_at: now },
      { id: 'b', color: '', state: 'committed', arrival_at: now - 120, is_me: false, last_seen_at: now },
      { id: 'c', color: '', state: 'interested', arrival_at: null, is_me: false, last_seen_at: now },
    ]
    const model = activityPresenceBadgeModel(activity({ my_state: 'committed', my_arrival_at: now + 60_000 }), now, participants)
    expect(model).toEqual({ user: 'committed', other: 'arrived', center: 'other' })
  })
})
