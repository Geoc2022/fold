import { fractalNoise2d } from './noise'
import { INTRO_PALETTE } from './nodeVisual'

// A field of colored nodes that drift horizontally *across* the title box.
// FoldTitleFX draws these and then clips them to the "Fold" text mask (see
// foldTextMask.paintBoilingMask), so the letters read as a window onto the
// same moving-node visual language used by the rooms and the favicon.
//
// The motion/spawning logic lives here (pure, deterministic given `rand`) so
// it can be unit-tested without a canvas or requestAnimationFrame.

export interface FieldNode {
  /** Horizontal position in CSS px (can be slightly off-canvas while wrapping). */
  x: number
  /** Current vertical position in CSS px (baseY + noise wobble). */
  y: number
  /** Home row the node wobbles around, in CSS px. */
  baseY: number
  /** Horizontal drift speed in CSS px per second (always rightward). */
  speed: number
  /** Peak vertical wobble in CSS px. */
  wobbleAmp: number
  /** Per-node phase so wobbles don't move in lockstep. */
  phase: number
  /** Draw radius in CSS px. */
  radius: number
  /** Fill color, drawn from INTRO_PALETTE. */
  color: string
}

export interface FieldConfig {
  width: number
  height: number
  count: number
  minRadius: number
  maxRadius: number
  speedMin: number
  speedMax: number
  /** Injectable RNG for deterministic tests; defaults to Math.random. */
  rand?: () => number
}

/** Extra px beyond each horizontal edge a node travels before wrapping, so
 * nodes glide fully off/onto the letters instead of popping at the border. */
export const FIELD_MARGIN = 24

/** How many nodes to run for a given title box width (CSS px). */
export function nodeCountForWidth(width: number): number {
  return Math.max(48, Math.min(200, Math.round(width * 0.9)))
}

export function createFieldNodes(cfg: FieldConfig): FieldNode[] {
  const rand = cfg.rand ?? Math.random
  const span = cfg.width + FIELD_MARGIN * 2
  const nodes: FieldNode[] = []
  for (let i = 0; i < cfg.count; i += 1) {
    const baseY = rand() * cfg.height
    nodes.push({
      x: rand() * span - FIELD_MARGIN,
      y: baseY,
      baseY,
      speed: cfg.speedMin + rand() * (cfg.speedMax - cfg.speedMin),
      wobbleAmp: cfg.height * (0.06 + rand() * 0.1),
      phase: rand() * Math.PI * 2,
      radius: cfg.minRadius + rand() * (cfg.maxRadius - cfg.minRadius),
      color: INTRO_PALETTE[i % INTRO_PALETTE.length],
    })
  }
  return nodes
}

/** Advance every node by `dtSec`, wrapping around the horizontal edges and
 * re-deriving the vertical wobble from `elapsedSec`. Deterministic: the same
 * inputs always yield the same positions (noise is a pure function). */
export function advanceFieldNodes(
  nodes: FieldNode[],
  cfg: Pick<FieldConfig, 'width' | 'height'>,
  dtSec: number,
  elapsedSec: number,
): void {
  const left = -FIELD_MARGIN
  const span = cfg.width + FIELD_MARGIN * 2
  for (const n of nodes) {
    n.x += n.speed * dtSec
    // Wrap rightward drift back to the left edge (handles arbitrarily large
    // dt without a loop, so a backgrounded tab resuming can't spin).
    if (n.x > cfg.width + FIELD_MARGIN) {
      n.x = left + ((n.x - left) % span + span) % span
    }
    const wobble = (fractalNoise2d(n.x * 0.02, elapsedSec * 0.35 + n.phase, 2) - 0.5) * 2
    n.y = n.baseY + wobble * n.wobbleAmp
  }
}
