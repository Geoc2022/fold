import { useEffect, useRef } from 'react'
import { deliverPolicyNotification } from '../notify-client'
import type { ActivityView } from '../types'
import { compileAndEvaluate, type Effect } from './engine'
import { buildActivityPolicyEnv } from './homeEnv'
import type { PolicyRule } from './rules'

interface EvalState {
  fired: boolean
  lastSeenAt: number
}

const fireState = new Map<string, EvalState>()
const STALE_STATE_MS = 12 * 60 * 60 * 1000

export interface ActivityNotificationOptions {
  activities: ActivityView[]
  now: number
  enabled: boolean
  revision: string
  resolveRules: (activity: ActivityView) => PolicyRule[]
  onNotify?: (activity: ActivityView, message: string) => void
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

function stateKey(activity: ActivityView, ruleId: string): string {
  const runId = activity.current_run?.id ?? `idle:${activity.id}`
  return `${runId}:${ruleId}`
}

function pruneOldFireState(now: number): void {
  for (const [key, state] of fireState) {
    if (now - state.lastSeenAt > STALE_STATE_MS) fireState.delete(key)
  }
}

export function useActivityNotifications({ activities, now, enabled, revision, resolveRules, onNotify }: ActivityNotificationOptions): void {
  const resolveRulesRef = useRef(resolveRules)
  const onNotifyRef = useRef(onNotify)

  useEffect(() => {
    resolveRulesRef.current = resolveRules
  }, [resolveRules])

  useEffect(() => {
    onNotifyRef.current = onNotify
  }, [onNotify])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const observedAt = Date.now()
    ;(async () => {
      for (const activity of activities) {
        const env = buildActivityPolicyEnv(activity, now)
        const rules = resolveRulesRef.current(activity)
        for (const rule of rules) {
          if (!rule.enabled || !rule.source.trim()) continue
          const key = stateKey(activity, rule.id)
          const result = await compileAndEvaluate(rule.source, env)
          if (cancelled) return
          const message = firstNotifyMessage(result.fired)
          const isFired = result.fired != null && result.fired.op !== 'noop'
          const prev = fireState.get(key)
          fireState.set(key, { fired: isFired, lastSeenAt: observedAt })
          if (!prev) continue // first sighting primes baseline silently
          if (message && !prev.fired && isFired) {
            onNotifyRef.current?.(activity, message)
            void deliverPolicyNotification(activity, message, key)
          }
        }
      }
      pruneOldFireState(observedAt)
    })()
    return () => {
      cancelled = true
    }
  }, [activities, enabled, now, revision])
}
