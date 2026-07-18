import { fractalNoise2d } from './noise'

export interface TextMask {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  imageData: ImageData
  widthPx: number
  heightPx: number
  dpr: number
}

function alphaAt(data: Uint8ClampedArray, widthPx: number, x: number, y: number): number {
  const idx = (y * widthPx + x) * 4 + 3
  return data[idx] ?? 0
}

export function createTextMask(opts: {
  widthCss: number
  heightCss: number
  dpr: number
  text: string
  font: string
  /** Top-left of the real DOM text's font box (CSS px, local to this mask's
   * canvas) -- see FoldTitleFX.measureGlyphAnchor. When provided, the glyph
   * is drawn to line up pixel-for-pixel with the live DOM text instead of
   * being naively centered in the (overscanned) mask box, which is what
   * caused the rendered "Fold" to visibly jump between the canvas fill and
   * the real heading. */
  anchor?: { x: number; y: number }
}): TextMask {
  const widthPx = Math.max(1, Math.floor(opts.widthCss * opts.dpr))
  const heightPx = Math.max(1, Math.floor(opts.heightCss * opts.dpr))
  const canvas = document.createElement('canvas')
  canvas.width = widthPx
  canvas.height = heightPx
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unable to create text mask context')

  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0)
  ctx.clearRect(0, 0, opts.widthCss, opts.heightCss)
  ctx.fillStyle = '#000'
  ctx.font = opts.font

  if (opts.anchor) {
    // Anchor at the top-left of the font's own ascent/descent box (matching
    // what Range.getBoundingClientRect() reports for the live text node),
    // so the baseline lands at anchor.y + fontBoundingBoxAscent -- the same
    // font-metric box the browser uses to lay out the real heading text,
    // not a Canvas-only "middle" approximation.
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const metrics = ctx.measureText(opts.text)
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent
    ctx.fillText(opts.text, opts.anchor.x, opts.anchor.y + ascent)
  } else {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(opts.text, opts.widthCss / 2, opts.heightCss / 2)
  }

  const imageData = ctx.getImageData(0, 0, widthPx, heightPx)
  return { canvas, ctx, imageData, widthPx, heightPx, dpr: opts.dpr }
}

export function sampleInteriorPoints(mask: TextMask, spacingCss: number, alphaThreshold = 40): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  const stepPx = Math.max(1, Math.floor(spacingCss * mask.dpr))
  const data = mask.imageData.data
  for (let y = 0; y < mask.heightPx; y += stepPx) {
    for (let x = 0; x < mask.widthPx; x += stepPx) {
      if (alphaAt(data, mask.widthPx, x, y) <= alphaThreshold) continue
      points.push({ x: x / mask.dpr, y: y / mask.dpr })
    }
  }
  return points
}

export function paintBoilingMask(opts: {
  targetCtx: CanvasRenderingContext2D
  cleanMask: TextMask
  outImage: ImageData
  timeMs: number
  roughPx: number
  speed: number
}): void {
  const w = opts.cleanMask.widthPx
  const h = opts.cleanMask.heightPx
  const clean = opts.cleanMask.imageData.data
  const out = opts.outImage.data
  out.fill(0)

  const amp = Math.max(0.3, opts.roughPx * opts.cleanMask.dpr)
  const t = opts.timeMs * opts.speed
  const base = 0.03

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = x * base
      const ny = y * base
      const xoff = (fractalNoise2d(nx + t * 0.75, ny - t * 0.62, 2) - 0.5) * amp * 2
      const yoff = (fractalNoise2d(nx - t * 0.54 + 9.31, ny + t * 0.71 - 2.17, 2) - 0.5) * amp * 2

      const sx = Math.min(w - 1, Math.max(0, Math.round(x + xoff)))
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + yoff)))
      const a = alphaAt(clean, w, sx, sy)
      if (a === 0) continue
      const i = (y * w + x) * 4
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      out[i + 3] = a
    }
  }

  opts.targetCtx.putImageData(opts.outImage, 0, 0)
}
