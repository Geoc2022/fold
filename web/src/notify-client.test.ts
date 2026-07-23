import { afterEach, describe, expect, it, vi } from 'vitest'

describe('push notification sound', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('plays one snap when an open page receives a push message', async () => {
    const listeners = new Map<string, EventListener>()
    const start = vi.fn()
    const oscillator = {
      type: 'sine',
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start,
      stop: vi.fn(),
    }
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }
    class AudioContextStub {
      state = 'running'
      currentTime = 1
      destination = {}
      createOscillator = vi.fn(() => oscillator)
      createGain = vi.fn(() => gain)
      resume = vi.fn().mockResolvedValue(undefined)
    }
    vi.stubGlobal('window', {
      AudioContext: AudioContextStub,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener)
      }),
    })

    await import('./notify-client')
    listeners.get('fold:push-notification')?.(new Event('fold:push-notification'))

    expect(start).toHaveBeenCalledTimes(2)
  })
})
