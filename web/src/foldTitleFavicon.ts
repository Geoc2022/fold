// The title fills the "Fold" letters with copies of the *default favicon*
// motif (favicon.svg): a yellow node with a blue node folded over it, the two
// separated by a thin white ring. FoldTitleFX stamps these across the letter
// band and clips (unions) them to the "Fold" text, so the letters read as a
// window onto the same node visual language as the favicon.
//
// The animation reveals the stamps from *low coverage to high coverage*: a
// global `coverage` value eases 0 -> 1, and each stamp only grows in (staggered
// by its `order`) as coverage passes it -- so the letters start barely dusted
// with favicons and fill up over the intro.
//
// All placement/coverage math lives here (pure, deterministic given `rand`) so
// it can be unit-tested without a canvas or requestAnimationFrame.

/** The two favicon colors (see public/favicon.svg): yellow node folded under a
 * blue node. */
export const FAVICON_YELLOW = '#FFB114'
export const FAVICON_BLUE = '#0078D0'

// Geometry ratios taken straight from favicon.svg (viewBox 250, circles r=67 at
// (106,106) & (145,145), stroke-width 12), expressed relative to a circle's
// radius so a stamp can be drawn at any size and still look like the favicon.
/** Diagonal offset between the two node centers, per unit circle radius:
 * (145-106)/67. */
export const OFFSET_RATIO = 39 / 67
/** White separation ring width, per unit circle radius: 12/67. */
export const STROKE_RATIO = 12 / 67

export interface FaviconStamp {
  /** Center of the favicon pair, in field CSS px. */
  cx: number
  cy: number
  /** Full (coverage === 1) circle radius in CSS px. */
  maxR: number
  /** Normalized appearance order in [0,1): lower stamps grow in first, so
   * coverage visibly builds from sparse to full. */
  order: number
  /** Per-stamp phase for the subtle idle shimmer once settled. */
  phase: number
}

export interface StampConfig {
  /** Field size (the glyph band) in CSS px. */
  width: number
  height: number
  /** Full circle radius in CSS px. */
  radius: number
  /** Grid spacing between stamp centers in CSS px. */
  spacing: number
  /** Positional jitter as a fraction of `spacing` (0 = perfect grid). */
  jitter: number
  /** Injectable RNG for deterministic tests; defaults to Math.random. */
  rand?: () => number
}

/** Fraction of the coverage sweep spent staggering stamps in. At 0 every stamp
 * grows together; near 1 they come in one long cascade. */
export const APPEAR_SPREAD = 0.7

function easeOutCubic(t: number): number {
  const c = clamp01(t)
  return 1 - Math.pow(1 - c, 3)
}

export function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Lay favicon stamps over the glyph band on a jittered grid. The grid is
 * padded one cell beyond every edge so partial stamps still cover letters that
 * reach the border (the text mask clips the overflow away). */
export function createFaviconStamps(cfg: StampConfig): FaviconStamp[] {
  const rand = cfg.rand ?? Math.random
  const step = Math.max(1, cfg.spacing)
  const cols = Math.max(1, Math.ceil(cfg.width / step) + 1)
  const rows = Math.max(1, Math.ceil(cfg.height / step) + 1)
  const jitterPx = step * cfg.jitter
  const stamps: FaviconStamp[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // Offset alternate rows half a cell so the grid reads as scattered nodes,
      // not a rigid lattice.
      const stagger = (row % 2) * step * 0.5
      const cx = col * step + stagger - step * 0.5 + (rand() - 0.5) * 2 * jitterPx
      const cy = row * step - step * 0.5 + (rand() - 0.5) * 2 * jitterPx
      stamps.push({
        cx,
        cy,
        maxR: cfg.radius * (0.82 + rand() * 0.36),
        order: rand(),
        phase: rand() * Math.PI * 2,
      })
    }
  }
  return stamps
}

/** Eased global coverage in [0,1] at `elapsedMs` into a `durationMs` reveal. */
export function coverageAt(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return easeOutCubic(elapsedMs / durationMs)
}

/** How far a stamp has grown in [0,1] for a given global `coverage`, staggered
 * by the stamp's `order` so low-order stamps fill first. Every stamp reaches 1
 * exactly when coverage reaches 1. */
export function stampProgress(coverage: number, order: number, spread = APPEAR_SPREAD): number {
  const s = clamp01(spread)
  const denom = Math.max(1e-6, 1 - s)
  return easeOutCubic((clamp01(coverage) - order * s) / denom)
}
