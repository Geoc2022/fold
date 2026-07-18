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
  onCommit?: (activity: ActivityView, etaDeltaSeconds: number | null) => void | Promise<void>
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

function commitEtaDeltas(effect: Effect | null): Array<number | null> {
  if (!effect) return []
  if (effect.op === 'state' && effect.state === 'committed') return [effect.eta_delta_secs ?? null]
  if (effect.op === 'seq') return effect.steps.flatMap(commitEtaDeltas)
  return []
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

  useEffect(() => {
    resolveRulesRef.current = resolveRules
  }, [resolveRules])

  useEffect(() => {
    onNotifyRef.current = onNotify
  }, [onNotify])

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

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
          const rising = isFired && !prev?.fired
          if (rising) {
            // Notifications prime silently on first sighting, but state
            // actions must run or an always-true rule would never take effect.
            if (prev && message) {
              onNotifyRef.current?.(activity, message)
              void deliverPolicyNotification(activity, message, key)
            }
            for (const delta of commitEtaDeltas(result.fired)) {
              await onCommitRef.current?.(activity, delta)
              if (cancelled) return
            }
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
