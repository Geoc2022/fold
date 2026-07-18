import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleInteriorPoints, createTextMask, paintBoilingMask, type TextMask } from '../foldTextMask'
import { INTRO_PALETTE } from '../nodeVisual'
import { spawnOutsideRing } from '../sandbox'

interface FxNode {
  x: number
  y: number
  vx: number
  vy: number
  tx: number
  ty: number
  radius: number
  alpha: number
  bornMs: number
  color: string
}

const SPRING_MASS = 0.065
const SPRING_DAMPING = 0.78
const CONVERGE_MS = 1150
const HOLD_MS = 360
const FADE_MS = 900
/** Damping applied to a node's velocity while dissolving outward during the
 * fade phase -- looser than SPRING_DAMPING so the outward drift imparted at
 * the start of the fade decays slowly instead of snapping to a stop. */
const FADE_DRIFT_DAMPING = 0.965

const OVERSCAN = 28

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Smooth ease used for the fade-out crossfade (node layer -> real text), so
 * the dissolve starts and ends gently instead of moving at a constant rate. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

function buildFont(el: HTMLElement): string {
  const cs = getComputedStyle(el)
  if (cs.font && cs.font.trim().length > 0) return cs.font
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
}

type Phase = 'idle' | 'converge' | 'hold' | 'fade'

export function FoldTitleFX() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodeLayerRef = useRef<HTMLCanvasElement | null>(null)
  const maskLayerRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)
  const startAtRef = useRef(0)
  const holdAtRef = useRef(0)
  const fadeAtRef = useRef(0)
  const phaseRef = useRef<Phase>('idle')
  const nodesRef = useRef<FxNode[]>([])
  const textMaskRef = useRef<TextMask | null>(null)
  const maskOutRef = useRef<ImageData | null>(null)
  const pointsRef = useRef<Array<{ x: number; y: number }>>([])

  const [isActive, setIsActive] = useState(false)

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    phaseRef.current = 'idle'
    setIsActive(false)
    const text = textRef.current
    if (text) text.style.opacity = '1'
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [])

  const rebuildLayout = useCallback(() => {
    const title = titleRef.current
    const canvas = canvasRef.current
    const text = textRef.current
    if (!title || !canvas || !text?.firstChild) return false

    const rect = title.getBoundingClientRect()
    const widthCss = rect.width + OVERSCAN * 2
    const heightCss = rect.height + OVERSCAN * 2
    if (widthCss <= 1 || heightCss <= 1) return false

    canvas.style.width = `${widthCss}px`
    canvas.style.height = `${heightCss}px`

    const dpr = Math.min(4, (window.devicePixelRatio || 1) * 2)
    canvas.width = Math.max(1, Math.floor(widthCss * dpr))
    canvas.height = Math.max(1, Math.floor(heightCss * dpr))

    nodeLayerRef.current = document.createElement('canvas')
    nodeLayerRef.current.width = canvas.width
    nodeLayerRef.current.height = canvas.height
    maskLayerRef.current = document.createElement('canvas')
    maskLayerRef.current.width = canvas.width
    maskLayerRef.current.height = canvas.height

    // The canvas is centered over `title` with OVERSCAN padding on every
    // side (see .fold-fx-canvas), so its top-left in viewport space is
    // exactly `rect` inset by -OVERSCAN. Measuring the *actual* rendered
    // text node's font box (not the h1's line-height-padded box) via Range
    // and expressing it relative to that same origin gives the exact spot
    // to draw the canvas glyph so it lines up with the live DOM text --
    // otherwise a Canvas-only "vertically centered" guess drifts from
    // wherever the browser's line-height/baseline actually placed the real
    // text, which read as the text "jumping" when it swapped back in.
    const range = document.createRange()
    range.selectNodeContents(text)
    const glyphRect = range.getBoundingClientRect()
    const canvasOriginX = rect.left - OVERSCAN
    const canvasOriginY = rect.top - OVERSCAN
    const anchor = { x: glyphRect.left - canvasOriginX, y: glyphRect.top - canvasOriginY }

    const textMask = createTextMask({
      widthCss,
      heightCss,
      dpr,
      text: 'Fold',
      font: buildFont(title),
      anchor,
    })
    textMaskRef.current = textMask
    maskOutRef.current = new ImageData(textMask.widthPx, textMask.heightPx)
    pointsRef.current = sampleInteriorPoints(textMask, 2.2, 20)
    return pointsRef.current.length > 10
  }, [])

  const spawnNodes = useCallback(() => {
    const canvas = canvasRef.current
    const points = pointsRef.current
    if (!canvas || points.length === 0) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const worldR = Math.max(26, Math.max(w, h) * 0.56)
    const shuffled = shuffle(points)
    const count = Math.min(420, Math.max(120, shuffled.length))

    const nodes: FxNode[] = []
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.9
      const spawn = spawnOutsideRing(canvas, angle, worldR, 2)
      const p = shuffled[i % shuffled.length]
      nodes.push({
        x: spawn.x + w / 2,
        y: spawn.y + h / 2,
        vx: 0,
        vy: 0,
        tx: p.x,
        ty: p.y,
        radius: 1.6 + Math.random() * 1.2,
        alpha: 0,
        bornMs: Math.random() * 280,
        color: INTRO_PALETTE[i % INTRO_PALETTE.length],
      })
    }
    nodesRef.current = shuffle(nodes)
  }, [])

  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current
    const mask = textMaskRef.current
    const nodeLayer = nodeLayerRef.current
    const maskLayer = maskLayerRef.current
    const maskOut = maskOutRef.current
    if (!canvas || !mask || !nodeLayer || !maskLayer || !maskOut) return

    const ctx = canvas.getContext('2d')
    const nctx = nodeLayer.getContext('2d')
    const mctx = maskLayer.getContext('2d')
    if (!ctx || !nctx || !mctx) return

    const elapsed = now - startAtRef.current
    const phase = phaseRef.current
    let fadeK = 1
    let textOpacity = 0

    if (phase === 'converge' && elapsed >= CONVERGE_MS) {
      phaseRef.current = 'hold'
      holdAtRef.current = now
    }
    if (phaseRef.current === 'hold' && now - holdAtRef.current >= HOLD_MS) {
      phaseRef.current = 'fade'
      fadeAtRef.current = now
      // Give every node a one-time outward nudge (away from the text's
      // center) right as the dissolve starts, so the fade-out reads as the
      // fill gently drifting apart rather than just dimming in place --
      // smoother/more organic than a flat opacity fade.
      const cx = canvas.clientWidth / 2
      const cy = canvas.clientHeight / 2
      for (const n of nodesRef.current) {
        const dx = n.x - cx
        const dy = n.y - cy
        const d = Math.max(1, Math.hypot(dx, dy))
        const k = 0.28 + Math.random() * 0.5
        n.vx += (dx / d) * k
        n.vy += (dy / d) * k
      }
    }
    if (phaseRef.current === 'fade') {
      const t = clamp01((now - fadeAtRef.current) / FADE_MS)
      const eased = easeInOutCubic(t)
      fadeK = 1 - eased
      textOpacity = eased
      if (t >= 1) {
        stop()
        return
      }
    }

    const fading = phaseRef.current === 'fade'
    for (const n of nodesRef.current) {
      const born = Math.max(0, now - startAtRef.current - n.bornMs)
      const visible = clamp01(born / 160)
      n.alpha += (visible - n.alpha) * 0.24
      if (fading) {
        // Let the outward impulse carry the node on its own momentum
        // instead of springing it back to its fill target, so the dissolve
        // keeps drifting outward smoothly for the whole fade.
        n.vx *= FADE_DRIFT_DAMPING
        n.vy *= FADE_DRIFT_DAMPING
      } else {
        n.vx += (n.tx - n.x) * SPRING_MASS
        n.vy += (n.ty - n.y) * SPRING_MASS
        n.vx *= SPRING_DAMPING
        n.vy *= SPRING_DAMPING
      }
      n.x += n.vx
      n.y += n.vy
    }

    const dpr = mask.dpr
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    nctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    for (const n of nodesRef.current) {
      const a = n.alpha * fadeK
      if (a <= 0.005) continue
      nctx.globalAlpha = a
      nctx.fillStyle = n.color
      nctx.beginPath()
      nctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
      nctx.fill()
    }
    nctx.globalAlpha = 1

    mctx.setTransform(1, 0, 0, 1, 0, 0)
    paintBoilingMask({
      targetCtx: mctx,
      cleanMask: mask,
      outImage: maskOut,
      timeMs: elapsed,
      roughPx: 1.6,
      speed: 0.0019,
    })

    nctx.setTransform(1, 0, 0, 1, 0, 0)
    nctx.globalCompositeOperation = 'destination-in'
    nctx.drawImage(maskLayer, 0, 0)
    nctx.globalCompositeOperation = 'source-over'

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(nodeLayer, 0, 0)

    const text = textRef.current
    if (text) text.style.opacity = String(textOpacity)
  }, [stop])

  const step = useCallback((now: number) => {
    drawFrame(now)
    if (phaseRef.current !== 'idle') rafRef.current = requestAnimationFrame(step)
  }, [drawFrame])

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle') return
    if (!rebuildLayout()) return
    spawnNodes()
    startAtRef.current = performance.now()
    phaseRef.current = 'converge'
    setIsActive(true)
    rafRef.current = requestAnimationFrame(step)
  }, [rebuildLayout, spawnNodes, step])

  useEffect(() => {
    const onResize = () => {
      if (phaseRef.current === 'idle') return
      stop()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      stop()
    }
  }, [stop])

  return (
    <h1
      ref={titleRef}
      className={`fold-fx${isActive ? ' is-active' : ''}`}
      onMouseEnter={start}
      onFocus={start}
      tabIndex={0}
    >
      <span ref={textRef} className="fold-fx-text">Fold</span>
      <canvas ref={canvasRef} className="fold-fx-canvas" aria-hidden="true" />
    </h1>
  )
}
