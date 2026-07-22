import { useEffect, useRef } from 'react'
import { deliverPolicyNotification } from '../notify-client'
import type { ActivityView } from '../types'
import { compileAndEvaluate, type Effect } from './engine'
import { runEffect, type EffectRun } from './effects'
import { buildActivityPolicyEnv } from './homeEnv'
import type { PolicyRule } from './rules'

interface EvalState {
  fired: boolean
  lastSeenAt: number
  source: string
}

const fireState = new Map<string, EvalState>()
const scheduledEffects = new Map<string, EffectRun>()
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

function hasStateEffect(effect: Effect | null): boolean {
  if (!effect) return false
  if (effect.op === 'state') return true
  return effect.op === 'seq' && effect.steps.some(hasStateEffect)
}

export interface NotificationTransition {
  notificationRising: boolean
  actionRising: boolean
  shouldRunEffect: boolean
}

export function computeNotificationTransition(
  prevFired: boolean | undefined,
  isFired: boolean,
  sourceChanged: boolean,
  effect: Effect | null,
): NotificationTransition {
  const notificationRising = isFired && prevFired != null && !prevFired
  const actionRising = isFired && (!prevFired || sourceChanged)
  return {
    notificationRising,
    actionRising,
    shouldRunEffect: actionRising && effect != null && (notificationRising || hasStateEffect(effect)),
  }
}

function cancelScheduledEffect(key: string) {
  const scheduled = scheduledEffects.get(key)
  if (!scheduled) return
  scheduled.cancel()
  scheduledEffects.delete(key)
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
    for (const key of ownedSchedulesRef.current) cancelScheduledEffect(key)
    ownedSchedulesRef.current.clear()
  }, [])

  useEffect(() => {
    if (enabled) return
    for (const key of ownedSchedulesRef.current) cancelScheduledEffect(key)
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
          const isFired = result.fired != null && result.fired.op !== 'noop'
          const prev = fireState.get(key)
          const sourceChanged = prev != null && prev.source !== rule.source
          fireState.set(key, { fired: isFired, lastSeenAt: observedAt, source: rule.source })
          if (sourceChanged) {
            cancelScheduledEffect(key)
            ownedSchedulesRef.current.delete(key)
          }
          const transition = computeNotificationTransition(prev?.fired, isFired, sourceChanged, result.fired)
          if (!isFired) {
            cancelScheduledEffect(key)
            ownedSchedulesRef.current.delete(key)
          }
          if (transition.shouldRunEffect && result.fired) {
            const commit = onCommitRef.current
            const allowNotify = transition.notificationRising
            let currentActivity = activity
            cancelScheduledEffect(key)
            const run = runEffect(result.fired, {
              onNotify: async (nextMessage) => {
                if (!allowNotify) return
                onNotifyRef.current?.(activity, nextMessage)
                await deliverPolicyNotification(activity, nextMessage, key)
              },
              onState: async (state, etaDeltaSeconds) => {
                if (state !== 'committed' || !commit) return
                const updated = await commit(currentActivity, etaDeltaSeconds)
                currentActivity = updated ?? currentActivity
              },
            })
            scheduledEffects.set(key, run)
            ownedSchedulesRef.current.add(key)
            void run.done.finally(() => {
              if (scheduledEffects.get(key) === run) {
                scheduledEffects.delete(key)
                ownedSchedulesRef.current.delete(key)
              }
            })
          }
        }
      }
      for (const key of ownedSchedulesRef.current) {
        if (!seenKeys.has(key)) {
          cancelScheduledEffect(key)
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
