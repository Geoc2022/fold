// Shared helpers for the demo room engine (BiologyRoom), which powers the
// /physics, /chemistry, /biology and /math sandboxes. These demos model ETA in
// milliseconds against a "world radius" timing ring, distinct from the
// minute-based room math used by the real activity room in `nodeVisual.ts`.

export const SANDBOX_HOLD_MS = 5_000
export const SANDBOX_MIN_ETA_MS = 0
export const SANDBOX_MAX_ETA_MS = 60 * 1000

/** ETA from how long the pointer was held on an interested node: a longer
 * hold means a sooner arrival (quadratic ease). */
export function etaFromHold(holdMs: number): number {
  const t = Math.min(1, Math.max(0, holdMs / SANDBOX_HOLD_MS))
  return SANDBOX_MIN_ETA_MS + (SANDBOX_MAX_ETA_MS - SANDBOX_MIN_ETA_MS) * (1 - t * t)
}

/** ETA from a committed node's distance to the center: farther is later,
 * scaled linearly against the page's timing ring (`worldR`). */
export function etaFromDistance(x: number, y: number, worldR: number): number {
  const r = Math.min(worldR, Math.max(0, Math.hypot(x, y)))
  return SANDBOX_MIN_ETA_MS + (SANDBOX_MAX_ETA_MS - SANDBOX_MIN_ETA_MS) * (r / worldR)
}

/** Project a freshly-created node onto a ray at `angle`, placed just beyond
 * the outer timing ring with a bounded exponential falloff farther out.
 * Clamps to the farthest visible point on that ray in small windows. */
export function spawnOutsideRing(
  canvas: HTMLCanvasElement,
  angle: number,
  worldR: number,
  nodeR: number,
): { x: number; y: number } {
  const margin = nodeR + 8
  const halfW = Math.max(margin, canvas.clientWidth / 2 - margin)
  const halfH = Math.max(margin, canvas.clientHeight / 2 - margin)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const maxR = Math.min(
    Math.abs(c) < 0.0001 ? Number.POSITIVE_INFINITY : halfW / Math.abs(c),
    Math.abs(s) < 0.0001 ? Number.POSITIVE_INFINITY : halfH / Math.abs(s),
  )
  const minR = worldR + nodeR + 8
  if (maxR <= minR) return { x: c * maxR, y: s * maxR }
  const scale = 72
  const maxExtra = maxR - minR
  const u = Math.random()
  const extra = -scale * Math.log(1 - u * (1 - Math.exp(-maxExtra / scale)))
  return { x: c * (minR + extra), y: s * (minR + extra) }
}

