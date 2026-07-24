import { useCallback, useEffect, useRef, useState } from 'react'
import { createTextMask, type TextMask } from '../foldTextMask'
import {
  FAVICON_BLUE,
  FAVICON_YELLOW,
  OFFSET_RATIO,
  STROKE_RATIO,
} from '../foldTitleFavicon'

// The title is rendered as a window onto the same two-node geometry as
// favicon.svg: yellow + blue circles with a white separation ring. On hover,
// both nodes start off-frame at bottom-right, then yellow passes first and
// blue follows; on mouse-out the motion reverses.

/** Padding (CSS px) around the h1's box so nodes can glide fully on/off the
 * letters and the boiling mask edge has room, instead of popping at the rim. */
const OVERSCAN = 28

/** Motion timing for the favicon-inspired node move on hover. */
const ENTER_SLOWDOWN = 3.4
const EXIT_SLOWDOWN = 6.8
const EXIT_EPSILON = 0.002
const MASK_FONT_SCALE = 0.990

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function easeOutCubic(t: number): number {
  const c = clamp01(t)
  return 1 - Math.pow(1 - c, 3)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function letterSpacingPx(el: HTMLElement): number {
  const raw = getComputedStyle(el).letterSpacing
  if (!raw || raw === 'normal') return 0
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function textColor(el: HTMLElement | null): string {
  if (!el) return '#fff'
  return getComputedStyle(el).color || '#fff'
}

function buildScaledFont(el: HTMLElement, scale: number): string {
  const cs = getComputedStyle(el)
  const sizePx = Number.parseFloat(cs.fontSize)
  const scaledSize = Number.isFinite(sizePx) ? `${Math.max(1, sizePx * scale)}px` : cs.fontSize
  const lineHeight = cs.lineHeight && cs.lineHeight !== 'normal' ? `/${cs.lineHeight}` : ''
  return `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${scaledSize}${lineHeight} ${cs.fontFamily}`
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function FoldTitleFX() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodeLayerRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)
  const runningRef = useRef(false)
  const hoveredRef = useRef(false)
  const progressRef = useRef(0)
  const lastAtRef = useRef(0)
  const textMaskRef = useRef<TextMask | null>(null)
  const motifRef = useRef({
    centerX: 0,
    centerY: 0,
    halfOffset: 0,
    radius: 0,
    stroke: 0,
    startX: 0,
    startY: 0,
  })

  const [isActive, setIsActive] = useState(false)

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    runningRef.current = false
    hoveredRef.current = false
    progressRef.current = 0
    lastAtRef.current = 0
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

    // The canvas is centered over `title` with OVERSCAN padding on every side
    // (see .fold-fx-canvas), so its top-left in viewport space is exactly
    // `rect` inset by -OVERSCAN. Measuring the *actual* rendered text node's
    // font box (not the h1's line-height-padded box) via Range and expressing
    // it relative to that same origin gives the exact spot to draw the canvas
    // glyph so the mask lines up pixel-for-pixel with the live DOM text.
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
      font: buildScaledFont(text, MASK_FONT_SCALE),
      letterSpacingPx: letterSpacingPx(text) * MASK_FONT_SCALE,
      anchor,
    })
    textMaskRef.current = textMask

    const glyphWidth = Math.max(1, glyphRect.width)
    const glyphHeight = Math.max(1, glyphRect.height)
    const radius = Math.max(8, glyphHeight * 0.92)
    const halfOffset = (radius * OFFSET_RATIO) * 0.5
    const startX = anchor.x + glyphWidth + radius * 1.9
    const startY = anchor.y + glyphHeight + radius * 1.9
    motifRef.current = {
      centerX: anchor.x + glyphWidth * 0.5,
      centerY: anchor.y + glyphHeight * 0.5,
      halfOffset,
      radius,
      stroke: Math.max(1, radius * STROKE_RATIO),
      startX,
      startY,
    }
    return true
  }, [])

  const drawFrame = useCallback((now: number): boolean => {
    const canvas = canvasRef.current
    const mask = textMaskRef.current
    const nodeLayer = nodeLayerRef.current
    if (!canvas || !mask || !nodeLayer) return false

    const ctx = canvas.getContext('2d')
    const nctx = nodeLayer.getContext('2d')
    if (!ctx || !nctx) return false

    const dtSec = lastAtRef.current <= 0 ? 1 / 60 : Math.max(0, (now - lastAtRef.current) / 1000)
    lastAtRef.current = now

    const target = hoveredRef.current ? 1 : 0
    const decay = hoveredRef.current ? ENTER_SLOWDOWN : EXIT_SLOWDOWN
    const factor = 1 - Math.exp(-decay * dtSec)
    const progress = progressRef.current + (target - progressRef.current) * factor
    progressRef.current = progress

    const intro = Math.max(clamp01(progress * 3), clamp01(progress / EXIT_EPSILON) * 0.22)
    const dpr = mask.dpr
    const motif = motifRef.current
    const yellowProgress = easeOutCubic(clamp01(progress * 1.36))
    const blueProgress = easeOutCubic((progress - 0.22) / 0.78)

    const yellowTargetX = motif.centerX - motif.halfOffset
    const yellowTargetY = motif.centerY - motif.halfOffset
    const blueTargetX = motif.centerX + motif.halfOffset
    const blueTargetY = motif.centerY + motif.halfOffset

    const yellowX = lerp(motif.startX, yellowTargetX, yellowProgress)
    const yellowY = lerp(motif.startY, yellowTargetY, yellowProgress)
    const blueX = lerp(motif.startX, blueTargetX, blueProgress)
    const blueY = lerp(motif.startY, blueTargetY, blueProgress)

    // Draw the favicon motif in text-local CSS coordinates.
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    nctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)

    const faviconBg = textColor(textRef.current)
    nctx.fillStyle = faviconBg
    nctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight)

    nctx.globalAlpha = intro

    nctx.fillStyle = FAVICON_BLUE
    nctx.strokeStyle = faviconBg
    nctx.lineWidth = motif.stroke
    nctx.beginPath()
    nctx.arc(blueX, blueY, motif.radius, 0, Math.PI * 2)
    nctx.fill()
    nctx.stroke()

    nctx.fillStyle = FAVICON_YELLOW
    nctx.beginPath()
    nctx.arc(yellowX, yellowY, motif.radius, 0, Math.PI * 2)
    nctx.fill()
    nctx.stroke()

    nctx.globalAlpha = 1
    nctx.setTransform(1, 0, 0, 1, 0, 0)
    nctx.globalCompositeOperation = 'destination-in'
    nctx.drawImage(mask.canvas, 0, 0)
    nctx.globalCompositeOperation = 'source-over'

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(nodeLayer, 0, 0)

    return hoveredRef.current || progressRef.current > EXIT_EPSILON
  }, [])

  const step = useCallback((now: number) => {
    const shouldContinue = drawFrame(now)
    if (shouldContinue) {
      rafRef.current = requestAnimationFrame(step)
      return
    }

    const text = textRef.current
    if (text) text.style.opacity = '1'
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    progressRef.current = 0
    lastAtRef.current = 0
    runningRef.current = false
    rafRef.current = 0
    setIsActive(false)
  }, [drawFrame])

  const ensureRunning = useCallback(() => {
    if (runningRef.current) return
    runningRef.current = true
    lastAtRef.current = 0
    rafRef.current = requestAnimationFrame(step)
  }, [step])

  const start = useCallback(() => {
    // Respect the OS "reduce motion" setting: leave the plain heading alone.
    if (prefersReducedMotion()) return
    if (!textMaskRef.current && !rebuildLayout()) return
    hoveredRef.current = true
    const text = textRef.current
    if (text) text.style.opacity = '0'
    setIsActive(true)
    ensureRunning()
  }, [ensureRunning, rebuildLayout])

  const end = useCallback(() => {
    hoveredRef.current = false
    if (progressRef.current > 0) {
      ensureRunning()
      return
    }
    stop()
  }, [ensureRunning, stop])

  useEffect(() => {
    const onResize = () => {
      if (!runningRef.current) return
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
      onMouseLeave={end}
      onFocus={start}
      onBlur={end}
      tabIndex={0}
    >
      <span ref={textRef} className="fold-fx-text">Fold</span>
      <canvas ref={canvasRef} className="fold-fx-canvas" aria-hidden="true" />
    </h1>
  )
}
