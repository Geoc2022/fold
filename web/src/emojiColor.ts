// Derives a per-tile accent color: render the emoji to an offscreen canvas,
// find its most-used opaque pixel color, and snap it to the nearest Nord
// palette swatch. Memoized since the canvas sampling is a little expensive
// and every activity with the same emoji shares the same result.

export const NORD_PALETTE = [
  '#2E3440', // nord0
  '#3B4252', // nord1
  '#434C5E', // nord2
  '#4C566A', // nord3
  '#D8DEE9', // nord4
  '#E5E9F0', // nord5
  '#ECEFF4', // nord6
  '#8FBCBB', // nord7
  '#88C0D0', // nord8
  '#81A1C1', // nord9
  '#5E81AC', // nord10
  '#BF616A', // nord11
  '#D08770', // nord12
  '#EBCB8B', // nord13
  '#A3BE8C', // nord14
  '#B48EAD', // nord15
]

const FALLBACK = NORD_PALETTE[8] // nord8

const cache = new Map<string, string>()
let sharedCanvas: HTMLCanvasElement | null = null

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function nearestNord(r: number, g: number, b: number): string {
  let best = NORD_PALETTE[0]
  let bestDist = Infinity
  for (const hex of NORD_PALETTE) {
    const [nr, ng, nb] = hexToRgb(hex)
    const d = (nr - r) ** 2 + (ng - g) ** 2 + (nb - b) ** 2
    if (d < bestDist) {
      bestDist = d
      best = hex
    }
  }
  return best
}

/** Most-used opaque color in the rendered emoji glyph, mapped to the nearest Nord swatch. */
export function nordColorForEmoji(emoji: string): string {
  const cached = cache.get(emoji)
  if (cached) return cached

  try {
    const size = 32
    const canvas = sharedCanvas ?? (sharedCanvas = document.createElement('canvas'))
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return FALLBACK

    ctx.clearRect(0, 0, size, size)
    ctx.font = `${Math.round(size * 0.85)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(emoji, size / 2, size / 2 + 1)

    const { data } = ctx.getImageData(0, 0, size, size)
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]
      if (a < 128) continue // transparent pixels aren't a "used color"
      // Quantize to reduce anti-aliasing noise between visually-identical colors.
      const r = Math.round(data[i] / 24) * 24
      const g = Math.round(data[i + 1] / 24) * 24
      const b = Math.round(data[i + 2] / 24) * 24
      const key = `${r},${g},${b}`
      const bucket = buckets.get(key)
      if (bucket) bucket.count += 1
      else buckets.set(key, { count: 1, r, g, b })
    }

    let mode: { count: number; r: number; g: number; b: number } | null = null
    for (const bucket of buckets.values()) {
      if (!mode || bucket.count > mode.count) mode = bucket
    }
    const result = mode ? nearestNord(mode.r, mode.g, mode.b) : FALLBACK
    cache.set(emoji, result)
    return result
  } catch {
    return FALLBACK
  }
}
