import { describe, expect, it } from 'vitest'
import { buildActivityShareText } from './activityShare'
import type { ActivityView, ParticipantView } from './types'

const activity = {
  emoji: '🎲',
  title: 'Game Night',
  code: 'GAME',
  grouping_mode: 'single',
  group_multiple: 1,
  min_people: 4,
} as ActivityView

it('builds a title, state grid, and link without a score', () => {
  const participants: ParticipantView[] = [
    { id: '1', color: '', state: 'committed', arrival_at: 50, is_me: false, last_seen_at: 0 },
    { id: '2', color: '', state: 'committed', arrival_at: 150, is_me: false, last_seen_at: 0 },
    { id: '3', color: '', state: 'interested', arrival_at: null, is_me: false, last_seen_at: 0 },
  ]
  expect(buildActivityShareText(activity, participants, 100, 'https://fold.test/GAME')).toBe(
    '🎲 Game Night — /GAME\n🔴🟠🟢⚪\nhttps://fold.test/GAME',
  )
})

describe('tiling activity shares', () => {
  it('uses one row per group-sized chunk', () => {
    const tiling = { ...activity, grouping_mode: 'tiling', group_multiple: 2 } as ActivityView
    const participants = Array.from({ length: 3 }, (_, index): ParticipantView => ({
      id: String(index), color: '', state: 'interested', arrival_at: null, is_me: false, last_seen_at: 0,
    }))
    expect(buildActivityShareText(tiling, participants, 0, 'url').split('\n')).toEqual([
      '🎲 Game Night — /GAME', '🟢🟢', '🟢⚪', 'url',
    ])
  })
})
