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

// ---- liveness / reachability -------------------------------------------
//
// There's no realtime layer (HTTP polling only, see usePolling.ts), so
// "reachable" is derived entirely from a participant's last heartbeat
// (`last_seen_at`, bumped server-side on every room/sync poll -- see
// db::heartbeat). This is purely a *display* signal: actual removal is
// server-authoritative (see db::reap_run/reap_person/reap_global), decided
// against DESPONDENT_MS server-side. The client only predicts the 50%
// dimming a bit ahead of the next poll for responsiveness.

/** Below this, a participant is shown at full opacity. Beyond it, dimmed to
 * 50% ("can't be reached") until either they're heard from again or the
 * server reaps them (mirrors DESPONDENT_MS in src/api.rs, ~5min later). */
export const REACHABLE_MS = 60_000

export function isReachable(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt <= REACHABLE_MS
}

/** Target opacity for a node: always full for your own node (you always
 * know you're live); dimmed for others once unreachable; fading to 0 while
 * exiting (server has removed this participant -- see RoomCanvas' exit
 * animation). */
export function targetOpacity(opts: { isMe: boolean; exiting: boolean; lastSeenAt: number | null; now: number }): number {
  if (opts.exiting) return 0
  if (opts.isMe || opts.lastSeenAt == null) return 1
  return isReachable(opts.lastSeenAt, opts.now) ? 1 : 0.5
}
