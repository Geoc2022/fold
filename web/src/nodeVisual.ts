import type { ParticipantView } from './types'

export type VisualNodeState = 'lurker' | 'interested' | 'committed' | 'arrived'

export interface VisualConfig {
  nodeRadius: number
  outlineWidth: number
  clusterTightness: number
}

export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  nodeRadius: 20,
  outlineWidth: 2,
  clusterTightness: 1.2,
}

export const HOLD_MS = 5_000
export const MIN_ETA_MIN = 0
export const MAX_ETA_MIN = 30
export const DEFAULT_ETA_MIN = 30

export function etaFromHold(holdMs: number): number {
  const t = Math.min(1, Math.max(0, holdMs / HOLD_MS))
  return Math.max(MIN_ETA_MIN, Math.min(MAX_ETA_MIN, Math.round(MAX_ETA_MIN * (1 - t * t))))
}

export function etaRemaining(arrivalAt: number | null, now: number): number {
  if (arrivalAt == null) return 0
  return Math.max(0, Math.ceil((arrivalAt - now) / 60000))
}

export function visualState(p: Pick<ParticipantView, 'state' | 'arrival_at'>, now: number): VisualNodeState {
  if (p.state === 'committed' && p.arrival_at != null && p.arrival_at <= now) return 'arrived'
  return p.state
}

export function nodeColor(state: VisualNodeState): string {
  if (state === 'arrived') return '#F0282D'
  if (state === 'committed') return '#FA841E'
  if (state === 'interested') return '#00A651'
  return '#969696'
}
