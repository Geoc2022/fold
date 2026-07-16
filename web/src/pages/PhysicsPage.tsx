import { useEffect, useRef } from 'react'
import { getCssVar, nodeColor } from '../nodeVisual'
import {
  angleFromCenter,
  etaFromDistance,
  etaFromHold,
  logNode,
  SANDBOX_HOLD_MS,
  SANDBOX_MAX_ETA_MS,
  spawnOutsideRing,
} from '../sandbox'
import { useForceTheme } from '../useForceTheme'

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
const WORLD_R = 320

export function PhysicsPage() {
  useForceTheme('light')
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
        ps.node.arrivalAt = Date.now() + etaFromDistance(ps.node.x, ps.node.y, WORLD_R)
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
        const target = spawnOutsideRing(canvas, angleFromCenter(click.x, click.y), WORLD_R, NODE_R)
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
    const targetR = Math.min(1, remaining / SANDBOX_MAX_ETA_MS) * WORLD_R
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
  ctx.fillStyle = getCssVar('--bg', '#ffffff')
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  ctx.globalAlpha = 0.06
  ctx.strokeStyle = getCssVar('--text', '#111827')
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = getCssVar('--text', '#111827')
  ctx.beginPath()
  ctx.arc(0, 0, 5, 0, Math.PI * 2)
  ctx.fill()

  drawNodesWithOutlineCutout(ctx, canvas, nodes, pointer)

  ctx.restore()
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
    lctx.fillStyle = nodeColor(n.state)
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
    const held = Math.min(SANDBOX_HOLD_MS, performance.now() - pointer.downAt)
    const etaMs = etaFromHold(held)
    lctx.fillText(`${Math.round(etaMs / 1000)}s`, pointer.node.x, pointer.node.y)
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function etaSeconds(arrivalAt: number) {
  return Math.max(0, Math.ceil((arrivalAt - Date.now()) / 1000))
}
