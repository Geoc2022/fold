import { describe, expect, it, vi } from 'vitest'
import type { Effect } from './engine'
import { collectEffectTimeline, runEffect, type TimelineEvent } from './effects'

describe('collectEffectTimeline', () => {
  it('accumulates sleep offsets and preserves order', () => {
    const effect: Effect = {
      op: 'seq',
      steps: [
        { op: 'notify', message: 'a' },
        { op: 'sleep', secs: 2 },
        { op: 'state', state: 'committed', eta_delta_secs: 30 },
        { op: 'sleep', secs: 1 },
        { op: 'notify', message: 'b' },
      ],
    }

    const timeline: TimelineEvent[] = []
    collectEffectTimeline(effect, 0, timeline)
    expect(timeline).toEqual([
      { afterMs: 0, effect: { op: 'notify', message: 'a' } },
      { afterMs: 2000, effect: { op: 'state', state: 'committed', eta_delta_secs: 30 } },
      { afterMs: 3000, effect: { op: 'notify', message: 'b' } },
    ])
  })
})

describe('runEffect', () => {
  it('runs delayed notify and state effects deterministically', async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const effect: Effect = {
        op: 'seq',
        steps: [
          { op: 'sleep', secs: 2 },
          { op: 'notify', message: 'hi' },
          { op: 'sleep', secs: 1 },
          { op: 'state', state: 'committed', eta_delta_secs: -180 },
        ],
      }

      const run = runEffect(effect, {
        onNotify: (message) => {
          seen.push(`notify:${message}`)
        },
        onState: (state, etaDeltaSeconds) => {
          seen.push(`state:${state}:${etaDeltaSeconds}`)
        },
      })

      await vi.advanceTimersByTimeAsync(1999)
      expect(seen).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(seen).toEqual(['notify:hi'])

      await vi.advanceTimersByTimeAsync(1000)
      expect(seen).toEqual(['notify:hi', 'state:committed:-180'])

      await run.done
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels pending delayed work', async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const run = runEffect(
        { op: 'seq', steps: [{ op: 'sleep', secs: 20 }, { op: 'notify', message: 'yo' }] },
        {
          onNotify: (message) => {
            seen.push(message)
          },
        },
      )

      run.cancel()
      await vi.advanceTimersByTimeAsync(20_000)
      await run.done
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats negative sleeps as zero', async () => {
    const seen: string[] = []
    const run = runEffect(
      { op: 'seq', steps: [{ op: 'sleep', secs: -10 }, { op: 'notify', message: 'now' }] },
      {
        onNotify: (message) => {
          seen.push(message)
        },
      },
    )

    await run.done
    expect(seen).toEqual(['now'])
  })
})
