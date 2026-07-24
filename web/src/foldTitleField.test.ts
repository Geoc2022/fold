import { describe, expect, it } from 'vitest'
import { INTRO_PALETTE } from './nodeVisual'
import {
  advanceFieldNodes,
  createFieldNodes,
  FIELD_MARGIN,
  nodeCountForWidth,
  type FieldConfig,
} from './foldTitleField'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const baseCfg: FieldConfig = {
  width: 120,
  height: 40,
  count: 30,
  minRadius: 1.5,
  maxRadius: 3,
  speedMin: 20,
  speedMax: 40,
}

describe('nodeCountForWidth', () => {
  it('scales with width but stays clamped', () => {
    expect(nodeCountForWidth(0)).toBe(48)
    expect(nodeCountForWidth(100)).toBe(90)
    expect(nodeCountForWidth(100000)).toBe(200)
  })
})

describe('createFieldNodes', () => {
  it('creates the requested count within bounds using the palette', () => {
    const nodes = createFieldNodes({ ...baseCfg, rand: seeded(1) })
    expect(nodes).toHaveLength(baseCfg.count)
    for (const [i, n] of nodes.entries()) {
      expect(n.x).toBeGreaterThanOrEqual(-FIELD_MARGIN)
      expect(n.x).toBeLessThanOrEqual(baseCfg.width + FIELD_MARGIN)
      expect(n.baseY).toBeGreaterThanOrEqual(0)
      expect(n.baseY).toBeLessThanOrEqual(baseCfg.height)
      expect(n.speed).toBeGreaterThanOrEqual(baseCfg.speedMin)
      expect(n.speed).toBeLessThanOrEqual(baseCfg.speedMax)
      expect(n.radius).toBeGreaterThanOrEqual(baseCfg.minRadius)
      expect(n.radius).toBeLessThanOrEqual(baseCfg.maxRadius)
      expect(n.color).toBe(INTRO_PALETTE[i % INTRO_PALETTE.length])
    }
  })

  it('is deterministic for a given rng', () => {
    const a = createFieldNodes({ ...baseCfg, rand: seeded(7) })
    const b = createFieldNodes({ ...baseCfg, rand: seeded(7) })
    expect(b).toEqual(a)
  })
})

describe('advanceFieldNodes', () => {
  it('drifts nodes rightward over time', () => {
    const nodes = createFieldNodes({ ...baseCfg, rand: seeded(3) })
    const before = nodes.map((n) => n.x)
    advanceFieldNodes(nodes, baseCfg, 0.5, 0.5)
    for (const [i, n] of nodes.entries()) {
      const expected = before[i] + nodes[i].speed * 0.5
      // Nodes that would cross the right margin wrap back around instead of
      // continuing rightward, so only the non-wrapping ones advance linearly.
      if (expected <= baseCfg.width + FIELD_MARGIN) {
        expect(n.x).toBeCloseTo(expected)
      } else {
        expect(n.x).toBeGreaterThanOrEqual(-FIELD_MARGIN)
        expect(n.x).toBeLessThanOrEqual(baseCfg.width + FIELD_MARGIN)
      }
    }
  })

  it('wraps back to the left edge once past the right margin', () => {
    const nodes = createFieldNodes({ ...baseCfg, rand: seeded(9) })
    const target = nodes[0]
    target.x = baseCfg.width + FIELD_MARGIN - 0.001
    advanceFieldNodes(nodes, baseCfg, 5, 1)
    expect(target.x).toBeGreaterThanOrEqual(-FIELD_MARGIN)
    expect(target.x).toBeLessThanOrEqual(baseCfg.width + FIELD_MARGIN)
  })

  it('keeps vertical wobble bounded around baseY', () => {
    const nodes = createFieldNodes({ ...baseCfg, rand: seeded(4) })
    for (let t = 0; t < 20; t += 1) {
      advanceFieldNodes(nodes, baseCfg, 0.1, t * 0.1)
      for (const n of nodes) {
        expect(Math.abs(n.y - n.baseY)).toBeLessThanOrEqual(n.wobbleAmp + 1e-6)
      }
    }
  })
})
