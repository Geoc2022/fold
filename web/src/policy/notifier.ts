import { useEffect, useRef } from 'react'
import { deliverPolicyNotification } from '../notify-client'
import type { ActivityView } from '../types'
import { compileAndEvaluate, type Effect } from './engine'
import { buildActivityPolicyEnv } from './homeEnv'
import type { PolicyRule } from './rules'

interface EvalState {
  fired: boolean
  lastSeenAt: number
  source: string
}

const fireState = new Map<string, EvalState>()
interface ScheduledCommit {
  cancelled: boolean
  timer: number | null
  wake: (() => void) | null
}
const scheduledCommits = new Map<string, ScheduledCommit>()
const STALE_STATE_MS = 12 * 60 * 60 * 1000

export interface ActivityNotificationOptions {
  activities: ActivityView[]
  now: number
  enabled: boolean
  revision: string
  resolveRules: (activity: ActivityView) => PolicyRule[]
  onNotify?: (activity: ActivityView, message: string) => void
  onCommit?: (activity: ActivityView, etaDeltaSeconds: number | null) => ActivityView | void | Promise<ActivityView | void>
}

function firstNotifyMessage(effect: Effect | null): string | null {
  if (!effect) return null
  if (effect.op === 'notify') return effect.message
  if (effect.op === 'seq') {
    for (const step of effect.steps) {
      const msg = firstNotifyMessage(step)
      if (msg) return msg
    }
  }
  return null
}

function hasCommitEffect(effect: Effect | null): boolean {
  if (!effect) return false
  if (effect.op === 'state') return effect.state === 'committed'
  return effect.op === 'seq' && effect.steps.some(hasCommitEffect)
}

function cancelScheduledCommit(key: string) {
  const scheduled = scheduledCommits.get(key)
  if (!scheduled) return
  scheduled.cancelled = true
  if (scheduled.timer != null) window.clearTimeout(scheduled.timer)
  scheduled.wake?.()
  scheduledCommits.delete(key)
}

function waitForEffect(secs: number, scheduled: ScheduledCommit): Promise<boolean> {
  if (secs <= 0) return Promise.resolve(!scheduled.cancelled)
  return new Promise((resolve) => {
    let finished = false
    const finish = (active: boolean) => {
      if (finished) return
      finished = true
      scheduled.timer = null
      scheduled.wake = null
      resolve(active)
    }
    scheduled.wake = () => finish(false)
    scheduled.timer = window.setTimeout(
      () => finish(!scheduled.cancelled),
      Math.min(secs * 1000, 2_147_483_647),
    )
  })
}

async function executeCommitEffects(
  effect: Effect,
  activity: ActivityView,
  scheduled: ScheduledCommit,
  onCommit: NonNullable<ActivityNotificationOptions['onCommit']>,
): Promise<ActivityView> {
  if (scheduled.cancelled) return activity
  if (effect.op === 'sleep') {
    await waitForEffect(Math.max(0, effect.secs), scheduled)
    return activity
  }
  if (effect.op === 'state' && effect.state === 'committed') {
    const updated = await onCommit(activity, effect.eta_delta_secs ?? null)
    return updated ?? activity
  }
  if (effect.op === 'seq') {
    let current = activity
    for (const step of effect.steps) {
      current = await executeCommitEffects(step, current, scheduled, onCommit)
      if (scheduled.cancelled) break
    }
    return current
  }
  return activity
}

function stateKey(activity: ActivityView, ruleId: string): string {
  const runId = activity.current_run?.id ?? `idle:${activity.id}`
  return `${runId}:${ruleId}`
}

function pruneOldFireState(now: number): void {
  for (const [key, state] of fireState) {
    if (now - state.lastSeenAt > STALE_STATE_MS) fireState.delete(key)
  }
}

export function useActivityNotifications({ activities, now, enabled, revision, resolveRules, onNotify, onCommit }: ActivityNotificationOptions): void {
  const resolveRulesRef = useRef(resolveRules)
  const onNotifyRef = useRef(onNotify)
  const onCommitRef = useRef(onCommit)
  const ownedSchedulesRef = useRef(new Set<string>())

  useEffect(() => {
    resolveRulesRef.current = resolveRules
  }, [resolveRules])

  useEffect(() => {
    onNotifyRef.current = onNotify
  }, [onNotify])

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  useEffect(() => () => {
    for (const key of ownedSchedulesRef.current) cancelScheduledCommit(key)
    ownedSchedulesRef.current.clear()
  }, [])

  useEffect(() => {
    if (enabled) return
    for (const key of ownedSchedulesRef.current) cancelScheduledCommit(key)
    ownedSchedulesRef.current.clear()
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const observedAt = Date.now()
    ;(async () => {
      const seenKeys = new Set<string>()
      for (const activity of activities) {
        const env = buildActivityPolicyEnv(activity, now)
        const rules = resolveRulesRef.current(activity)
        for (const rule of rules) {
          if (!rule.enabled || !rule.source.trim()) continue
          const key = stateKey(activity, rule.id)
          seenKeys.add(key)
          const result = await compileAndEvaluate(rule.source, env)
          if (cancelled) return
          const message = firstNotifyMessage(result.fired)
          const isFired = result.fired != null && result.fired.op !== 'noop'
          const prev = fireState.get(key)
          const sourceChanged = prev != null && prev.source !== rule.source
          fireState.set(key, { fired: isFired, lastSeenAt: observedAt, source: rule.source })
          if (sourceChanged) {
            cancelScheduledCommit(key)
            ownedSchedulesRef.current.delete(key)
          }
          const notificationRising = isFired && prev != null && !prev.fired
          const actionRising = isFired && (!prev?.fired || sourceChanged)
          if (!isFired) {
            cancelScheduledCommit(key)
            ownedSchedulesRef.current.delete(key)
          }
          if (notificationRising || actionRising) {
            // Notifications prime silently on first sighting, but state
            // actions must run or an always-true rule would never take effect.
            if (notificationRising && message) {
              onNotifyRef.current?.(activity, message)
              void deliverPolicyNotification(activity, message, key)
            }
            const commit = onCommitRef.current
            if (actionRising && commit && result.fired && hasCommitEffect(result.fired)) {
              cancelScheduledCommit(key)
              const scheduled: ScheduledCommit = { cancelled: false, timer: null, wake: null }
              scheduledCommits.set(key, scheduled)
              ownedSchedulesRef.current.add(key)
              void executeCommitEffects(result.fired, activity, scheduled, commit)
                .catch(() => {})
                .finally(() => {
                  if (scheduledCommits.get(key) === scheduled) {
                    scheduledCommits.delete(key)
                    ownedSchedulesRef.current.delete(key)
                  }
                })
            }
          }
        }
      }
      for (const key of ownedSchedulesRef.current) {
        if (!seenKeys.has(key)) {
          cancelScheduledCommit(key)
          ownedSchedulesRef.current.delete(key)
        }
      }
      pruneOldFireState(observedAt)
    })()
    return () => {
      cancelled = true
    }
  }, [activities, enabled, now, revision])
}
