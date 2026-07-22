import { describe, expect, it } from 'vitest'
import type { Effect } from './engine'
import { computeNotificationTransition } from './notifier'

describe('computeNotificationTransition', () => {
  const notifyEffect: Effect = { op: 'notify', message: 'hi' }
  const stateEffect: Effect = { op: 'state', state: 'committed' }

  it('primes initial notify-only firing silently', () => {
    const transition = computeNotificationTransition(undefined, true, false, notifyEffect)
    expect(transition).toEqual({
      notificationRising: false,
      actionRising: true,
      shouldRunEffect: false,
    })
  })

  it('runs notify effect on false-to-true transition', () => {
    const transition = computeNotificationTransition(false, true, false, notifyEffect)
    expect(transition).toEqual({
      notificationRising: true,
      actionRising: true,
      shouldRunEffect: true,
    })
  })

  it('runs state effects on first sighting', () => {
    const transition = computeNotificationTransition(undefined, true, false, stateEffect)
    expect(transition).toEqual({
      notificationRising: false,
      actionRising: true,
      shouldRunEffect: true,
    })
  })

  it('does not rerun notify-only effects when only source changes', () => {
    const transition = computeNotificationTransition(true, true, true, notifyEffect)
    expect(transition).toEqual({
      notificationRising: false,
      actionRising: true,
      shouldRunEffect: false,
    })
  })

  it('reruns state effects when source changes', () => {
    const transition = computeNotificationTransition(true, true, true, stateEffect)
    expect(transition).toEqual({
      notificationRising: false,
      actionRising: true,
      shouldRunEffect: true,
    })
  })

  it('does nothing when rule is not fired', () => {
    const transition = computeNotificationTransition(true, false, false, notifyEffect)
    expect(transition).toEqual({
      notificationRising: false,
      actionRising: false,
      shouldRunEffect: false,
    })
  })
})
