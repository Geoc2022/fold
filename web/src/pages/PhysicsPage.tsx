import { useEffect, useRef } from 'react'
import { nodeColor } from '../nodeVisual'

type NodeState = 'lurker' | 'interested' | 'committed'

interface Node {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  state: NodeState
  arrivalAt: number | null
  targetX?: number
  targetY?: number
}

interface PointerState {
  id: number
  node: Node | null
  startX: number
  startY: number
  lastX: number
  lastY: number
  downAt: number
  dragging: boolean
}

const NODE_R = 25
const HOLD_MS = 5_000
const MIN_ETA_MS = 0
const MAX_ETA_MS = 60 * 1000
const WORLD_R = 320

export function PhysicsPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<Node[]>([])
  const nextIdRef = useRef(1)
  const pointerRef = useRef<PointerState | null>(null)
  const lastLogRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const toWorld = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      }
    }

    const hit = (x: number, y: number) => {
      for (let i = nodesRef.current.length - 1; i >= 0; i -= 1) {
        const n = nodesRef.current[i]
        if (Math.hypot(n.x - x, n.y - y) <= NODE_R + 4) return n
      }
      return null
    }

    const onPointerDown = (e: PointerEvent) => {
      const p = toWorld(e)
      const node = hit(p.x, p.y)
      pointerRef.current = {
        id: e.pointerId,
        node,
        startX: p.x,
        startY: p.y,
        lastX: p.x,
        lastY: p.y,
        downAt: performance.now(),
        dragging: false,
      }
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId || !ps.node) return
      const p = toWorld(e)
      if (Math.hypot(p.x - ps.startX, p.y - ps.startY) > 6) ps.dragging = true
      ps.node.x = p.x
      ps.node.y = p.y
      ps.node.vx = 0
      ps.node.vy = 0
      if (ps.node.state === 'committed') {
        ps.node.arrivalAt = Date.now() + etaFromDistance(ps.node.x, ps.node.y)
        logNode(ps.node)
      }
      ps.lastX = p.x
      ps.lastY = p.y
    }

    const onPointerUp = (e: PointerEvent) => {
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      const held = performance.now() - ps.downAt

      if (!ps.node) {
        const click = toWorld(e)
        const target = spawnOutsideOuterRing(canvas, click.x, click.y)
        nodesRef.current.push({
          id: nextIdRef.current,
          x: click.x,
          y: click.y,
          vx: 0,
          vy: 0,
          state: 'lurker',
          arrivalAt: null,
          targetX: target.x,
          targetY: target.y,
        })
        nextIdRef.current += 1
      } else if (!ps.dragging) {
        if (ps.node.state === 'lurker') {
          ps.node.state = 'interested'
        } else if (ps.node.state === 'interested' && held > 200) {
          ps.node.state = 'committed'
          ps.node.arrivalAt = Date.now() + etaFromHold(held)
          logNode(ps.node)
        }
      }
      pointerRef.current = null
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    let raf = 0
    const frame = () => {
      step(nodesRef.current, pointerRef.current)
      draw(ctx, canvas, nodesRef.current, pointerRef.current)
      const now = performance.now()
      if (now - lastLogRef.current > 1000) {
        lastLogRef.current = now
        nodesRef.current.forEach(logNode)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <main className="physics-page">
      <canvas ref={canvasRef} className="physics-canvas" />
      <div className="physics-help">
        Click empty space: create node. Click gray: interested. Hold green: commit. Drag gold: adjust ETA.
      </div>
    </main>
  )
}

function step(nodes: Node[], pointer: PointerState | null) {
  const now = Date.now()
  for (const n of nodes) {
    if (pointer?.node === n && pointer.dragging) continue
    if (n.state === 'lurker' && n.targetX != null && n.targetY != null) {
      n.vx += (n.targetX - n.x) * 0.03
      n.vy += (n.targetY - n.y) * 0.03
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      if (Math.hypot(n.targetX - n.x, n.targetY - n.y) < 1.5) {
        n.x = n.targetX
        n.y = n.targetY
        n.vx = 0
        n.vy = 0
        delete n.targetX
        delete n.targetY
      }
      continue
    }
    if (n.state !== 'committed' || n.arrivalAt == null) continue
    const remaining = Math.max(0, n.arrivalAt - now)
    const targetR = Math.min(1, remaining / MAX_ETA_MS) * WORLD_R
    const angle = Math.atan2(n.y, n.x) || 0
    const tx = Math.cos(angle) * targetR
    const ty = Math.sin(angle) * targetR
    n.vx += (tx - n.x) * 0.03
    n.vy += (ty - n.y) * 0.03
    n.vx *= 0.82
    n.vy *= 0.82
    n.x += n.vx
    n.y += n.vy
  }
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: Node[],
  pointer: PointerState | null,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = getCss('--bg')
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  ctx.globalAlpha = 0.06
  ctx.strokeStyle = getCss('--text')
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = getCss('--text')
  ctx.beginPath()
  ctx.arc(0, 0, 5, 0, Math.PI * 2)
  ctx.fill()

  drawNodesWithOutlineCutout(ctx, canvas, nodes, pointer)

  ctx.restore()
}

function colorFor(state: NodeState) {
  return nodeColor(state)
}

function drawNodesWithOutlineCutout(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: Node[],
  pointer: PointerState | null,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const dpr = canvas.width / Math.max(1, w)
  const layer = document.createElement('canvas')
  layer.width = canvas.width
  layer.height = canvas.height
  const lctx = layer.getContext('2d')
  if (!lctx) return

  lctx.scale(dpr, dpr)
  lctx.translate(w / 2, h / 2)
  lctx.globalCompositeOperation = 'source-over'
  for (const n of nodes) {
    lctx.fillStyle = colorFor(n.state)
    lctx.beginPath()
    lctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2)
    lctx.fill()
  }

  // Cut outlines out of the node layer after the XOR fill. Because this is on
  // the transparent layer, the main canvas/grid shows through the outline.
  lctx.globalCompositeOperation = 'destination-out'
  lctx.lineWidth = 4
  for (const n of nodes) {
    lctx.beginPath()
    lctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2)
    lctx.stroke()
  }

  // Center ETA text inside circles and XOR it against the node layer. This
  // keeps the text visually tied to the circle while cutting through the fill.
  lctx.globalCompositeOperation = 'xor'
  lctx.fillStyle = '#fff'
  lctx.font = '700 12px system-ui, sans-serif'
  lctx.textAlign = 'center'
  lctx.textBaseline = 'middle'
  for (const n of nodes) {
    if (n.state === 'committed' && n.arrivalAt != null) {
      lctx.fillText(`${etaSeconds(n.arrivalAt)}s`, n.x, n.y)
    }
  }
  if (pointer?.node?.state === 'interested' && !pointer.dragging) {
    const held = Math.min(HOLD_MS, performance.now() - pointer.downAt)
    const etaMs = etaFromHold(held)
    lctx.fillText(`${Math.round(etaMs / 1000)}s`, pointer.node.x, pointer.node.y)
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function etaFromHold(holdMs: number) {
  const t = Math.min(1, Math.max(0, holdMs / HOLD_MS))
  return MIN_ETA_MS + (MAX_ETA_MS - MIN_ETA_MS) * (1 - t * t)
}

function etaFromDistance(x: number, y: number) {
  const r = Math.min(WORLD_R, Math.max(0, Math.hypot(x, y)))
  return MIN_ETA_MS + (MAX_ETA_MS - MIN_ETA_MS) * (r / WORLD_R)
}

function spawnOutsideOuterRing(canvas: HTMLCanvasElement, clickX: number, clickY: number) {
  const margin = NODE_R + 8
  const halfW = Math.max(margin, canvas.clientWidth / 2 - margin)
  const halfH = Math.max(margin, canvas.clientHeight / 2 - margin)

  // Keep the user's click direction, but project the node beyond the outer
  // timing ring. A center click has no direction, so pick an arbitrary upward
  // ray rather than producing NaN coordinates.
  const angle = Math.hypot(clickX, clickY) < 0.001 ? -Math.PI / 2 : Math.atan2(clickY, clickX)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const maxR = Math.min(
    Math.abs(c) < 0.0001 ? Number.POSITIVE_INFINITY : halfW / Math.abs(c),
    Math.abs(s) < 0.0001 ? Number.POSITIVE_INFINITY : halfH / Math.abs(s),
  )
  const minR = WORLD_R + NODE_R + 8

  // In normal-size windows this puts the node just outside WORLD_R, with a
  // bounded exponential falloff farther outward on the same ray. In small
  // windows, clamp to the farthest visible point on that ray.
  if (maxR <= minR) return { x: c * maxR, y: s * maxR }
  const scale = 72
  const maxExtra = maxR - minR
  const u = Math.random()
  const extra = -scale * Math.log(1 - u * (1 - Math.exp(-maxExtra / scale)))
  const r = minR + extra
  return { x: c * r, y: s * r }
}

function etaSeconds(arrivalAt: number) {
  return Math.max(0, Math.ceil((arrivalAt - Date.now()) / 1000))
}

function logNode(n: Node) {
  const distance = Math.round(Math.hypot(n.x, n.y))
  const eta = n.arrivalAt == null ? null : etaSeconds(n.arrivalAt)
  console.log(`node ${n.id}: distance=${distance}px eta=${eta ?? 'n/a'}s state=${n.state}`)
}

function getCss(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#111827'
}
