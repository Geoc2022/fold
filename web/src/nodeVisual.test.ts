import { describe, expect, it } from 'vitest'
import {
  HOLD_MS,
  MAX_ETA_MIN,
  MIN_ETA_MIN,
  REACHABLE_MS,
  etaFromHold,
  etaRemaining,
  isReachable,
  nodeColor,
  targetOpacity,
  visualState,
} from './nodeVisual'

describe('visualState', () => {
  it('reports interested/committed/lurker as-is', () => {
    expect(visualState({ state: 'lurker' as never, arrival_at: null }, 0)).toBe('lurker')
    expect(visualState({ state: 'interested', arrival_at: null }, 0)).toBe('interested')
  })

  it('promotes committed to arrived once arrival_at has passed', () => {
    expect(visualState({ state: 'committed', arrival_at: 100 }, 100)).toBe('arrived')
    expect(visualState({ state: 'committed', arrival_at: 100 }, 150)).toBe('arrived')
  })

  it('keeps committed as committed before arrival_at', () => {
    expect(visualState({ state: 'committed', arrival_at: 100 }, 50)).toBe('committed')
  })

  it('keeps committed as committed when arrival_at is null (no ETA yet)', () => {
    expect(visualState({ state: 'committed', arrival_at: null }, 999)).toBe('committed')
  })
})

describe('nodeColor', () => {
  it('maps every visual state to a distinct color', () => {
    const colors = new Set(['lurker', 'interested', 'committed', 'arrived'].map((s) => nodeColor(s as never)))
    expect(colors.size).toBe(4)
  })
})

describe('etaFromHold', () => {
  it('clamps to MIN_ETA_MIN at zero hold', () => {
    expect(etaFromHold(0)).toBe(MAX_ETA_MIN)
  })

  it('clamps to MIN_ETA_MIN at or beyond HOLD_MS', () => {
    expect(etaFromHold(HOLD_MS)).toBe(MIN_ETA_MIN)
    expect(etaFromHold(HOLD_MS * 2)).toBe(MIN_ETA_MIN)
  })

  it('is monotonically non-increasing as hold time grows', () => {
    const a = etaFromHold(1_000)
    const b = etaFromHold(3_000)
    expect(b).toBeLessThanOrEqual(a)
  })
})

describe('etaRemaining', () => {
  it('is 0 when there is no arrival time', () => {
    expect(etaRemaining(null, 1000)).toBe(0)
  })

  it('rounds up remaining minutes and never goes negative', () => {
    expect(etaRemaining(60_000, 0)).toBe(1)
    expect(etaRemaining(1000, 5000)).toBe(0) // already in the past
  })
})

// ---- liveness / reachability (this task's core addition) -----------------

describe('isReachable', () => {
  it('is reachable exactly at the threshold', () => {
    expect(isReachable(0, REACHABLE_MS)).toBe(true)
  })

  it('is unreachable just past the threshold', () => {
    expect(isReachable(0, REACHABLE_MS + 1)).toBe(false)
  })

  it('is reachable well within the window', () => {
    expect(isReachable(1_000, 1_000)).toBe(true)
  })
})

describe('targetOpacity', () => {
  it('is always full for your own node, even if "unreachable" or lastSeenAt is stale', () => {
    expect(targetOpacity({ isMe: true, exiting: false, lastSeenAt: 0, now: REACHABLE_MS + 100_000 })).toBe(1)
  })

  it('is full for others with no lastSeenAt (synthetic/local-only nodes)', () => {
    expect(targetOpacity({ isMe: false, exiting: false, lastSeenAt: null, now: 0 })).toBe(1)
  })

  it('is full for a reachable other participant', () => {
    expect(targetOpacity({ isMe: false, exiting: false, lastSeenAt: 0, now: REACHABLE_MS })).toBe(1)
  })

  it('dims to 0.5 for an unreachable other participant', () => {
    expect(targetOpacity({ isMe: false, exiting: false, lastSeenAt: 0, now: REACHABLE_MS + 1 })).toBe(0.5)
  })

  it('is 0 while exiting, regardless of reachability or isMe', () => {
    expect(targetOpacity({ isMe: false, exiting: true, lastSeenAt: 0, now: 0 })).toBe(0)
    expect(targetOpacity({ isMe: true, exiting: true, lastSeenAt: null, now: 0 })).toBe(0)
  })
})
