import { describe, expect, it } from 'vitest'
import {
  APPEAR_SPREAD,
  clamp01,
  coverageAt,
  createFaviconStamps,
  OFFSET_RATIO,
  STROKE_RATIO,
  stampProgress,
  type StampConfig,
} from './foldTitleFavicon'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const baseCfg: StampConfig = {
  width: 120,
  height: 40,
  radius: 8,
  spacing: 10,
  jitter: 0.3,
}

describe('favicon geometry constants', () => {
  it('mirror the ratios in favicon.svg', () => {
    expect(OFFSET_RATIO).toBeCloseTo(39 / 67)
    expect(STROKE_RATIO).toBeCloseTo(12 / 67)
  })
})

describe('createFaviconStamps', () => {
  it('covers the glyph band with a padded jittered grid', () => {
    const stamps = createFaviconStamps({ ...baseCfg, rand: seeded(1) })
    // ceil(120/10)+1 cols * ceil(40/10)+1 rows = 13 * 5
    expect(stamps).toHaveLength(13 * 5)
    for (const s of stamps) {
      expect(s.order).toBeGreaterThanOrEqual(0)
      expect(s.order).toBeLessThan(1)
      expect(s.maxR).toBeGreaterThan(0)
      // radius varies within the documented 0.82..1.18 band
      expect(s.maxR).toBeGreaterThanOrEqual(baseCfg.radius * 0.82 - 1e-6)
      expect(s.maxR).toBeLessThanOrEqual(baseCfg.radius * 1.18 + 1e-6)
    }
  })

  it('is deterministic for a given rng', () => {
    const a = createFaviconStamps({ ...baseCfg, rand: seeded(7) })
    const b = createFaviconStamps({ ...baseCfg, rand: seeded(7) })
    expect(b).toEqual(a)
  })
})

describe('coverageAt', () => {
  it('grows monotonically from 0 to 1 across the reveal', () => {
    expect(coverageAt(0, 1000)).toBe(0)
    expect(coverageAt(1000, 1000)).toBeCloseTo(1)
    const mid = coverageAt(500, 1000)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    // eased (ease-out): halfway through time is already past halfway coverage
    expect(mid).toBeGreaterThan(0.5)
  })

  it('clamps past the end and treats a zero duration as fully covered', () => {
    expect(coverageAt(5000, 1000)).toBeCloseTo(1)
    expect(coverageAt(0, 0)).toBe(1)
  })
})

describe('stampProgress', () => {
  it('reveals low-order stamps before high-order ones', () => {
    const early = stampProgress(0.4, 0)
    const late = stampProgress(0.4, 0.95)
    expect(early).toBeGreaterThan(late)
    expect(late).toBe(0)
  })

  it('leaves everything hidden at zero coverage and full at full coverage', () => {
    for (const order of [0, 0.5, 0.99]) {
      expect(stampProgress(0, order)).toBe(0)
      expect(stampProgress(1, order)).toBeCloseTo(1)
    }
  })

  it('is monotonic in coverage for a fixed stamp', () => {
    let prev = -1
    for (let c = 0; c <= 1.0001; c += 0.1) {
      const p = stampProgress(c, 0.5)
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = p
    }
  })

  it('honors the appearance spread setting', () => {
    // With no spread, every stamp tracks coverage identically.
    expect(stampProgress(0.5, 0, 0)).toBeCloseTo(stampProgress(0.5, 0.9, 0))
    expect(APPEAR_SPREAD).toBeGreaterThan(0)
  })
})

describe('clamp01', () => {
  it('clamps to the unit interval', () => {
    expect(clamp01(-2)).toBe(0)
    expect(clamp01(0.3)).toBe(0.3)
    expect(clamp01(4)).toBe(1)
  })
})
