// Chemistry sandbox — physics interaction model (click/hold/drag) with node
// fusion: once a committed node reaches the center it joins a cluster ring,
// forming "circles made out of circles" like the activity room grouping.

import { useEffect, useRef } from 'react'

type NodeState = 'lurker' | 'interested' | 'committed'

interface Node {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  state: NodeState
  arrivalAt: number | null
  // spawn animation
  targetX?: number
  targetY?: number
  // stable hash angle so the node has a consistent direction from center
  angle: number
}

interface PointerState {
  id: number
  node: Node | null
  startX: number
  startY: number
  downAt: number
  dragging: boolean
}

const NODE_R = 25
const HOLD_MS = 5_000
const MIN_ETA_MS = 0
const MAX_ETA_MS = 60 * 1000
const WORLD_R = 300
// how close to target orbit radius before a committed node is considered "arrived"
const ARRIVE_THRESHOLD = 6
// number of committed nodes per group before a new group starts
const GROUP_SIZE = 3

export function ChemistryPage() {
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
      // Update angle so physics targets along the new direction
      const dist = Math.hypot(p.x, p.y)
      if (dist > 1) ps.node.angle = Math.atan2(p.y, p.x)
      if (ps.node.state === 'committed') {
        ps.node.arrivalAt = Date.now() + etaFromDistance(p.x, p.y)
        logNode(ps.node)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      const held = performance.now() - ps.downAt

      if (!ps.node) {
        const click = toWorld(e)
        const angle = Math.hypot(click.x, click.y) < 0.001
          ? -Math.PI / 2
          : Math.atan2(click.y, click.x)
        const target = spawnTarget(canvas, angle)
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
          angle,
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
        nodesRef.current.filter(n => n.state === 'committed').forEach(logNode)
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
    <main className="chemistry-page">
      <canvas ref={canvasRef} className="physics-canvas" />
      <div className="physics-help">
        Click empty space: create node. Click gray: interested. Hold green: commit. Drag gold: adjust ETA. Nodes fuse into groups at the center.
      </div>
    </main>
  )
}

// ---- simulation ------------------------------------------------------------

function step(nodes: Node[], pointer: PointerState | null) {
  const now = Date.now()
  const committed = nodes.filter(n => n.state === 'committed')

  // Assign targets for each committed node based on group membership
  const groupTargets = computeGroupTargets(committed, now)

  for (const n of nodes) {
    if (pointer?.node === n && pointer.dragging) continue

    // Spawn animation: lurker flies to outer ring
    if (n.state === 'lurker' && n.targetX != null && n.targetY != null) {
      n.vx += (n.targetX - n.x) * 0.03
      n.vy += (n.targetY - n.y) * 0.03
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      if (Math.hypot(n.targetX - n.x, n.targetY - n.y) < ARRIVE_THRESHOLD) {
        n.x = n.targetX
        n.y = n.targetY
        n.vx = 0
        n.vy = 0
        delete n.targetX
        delete n.targetY
      }
      continue
    }

    if (n.state === 'committed') {
      const target = groupTargets.get(n.id) ?? { x: 0, y: 0 }
      n.vx += (target.x - n.x) * 0.04
      n.vy += (target.y - n.y) * 0.04
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      logNode(n)
    }
  }
}

function computeGroupTargets(committed: Node[], now: number): Map<number, { x: number; y: number }> {
  const targets = new Map<number, { x: number; y: number }>()

  // Separate into: arrived (ETA elapsed) and in-flight
  const arrived: Node[] = []
  const inFlight: Node[] = []
  for (const n of committed) {
    const remaining = n.arrivalAt == null ? MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    if (remaining === 0) {
      arrived.push(n)
    } else {
      inFlight.push(n)
    }
  }

  // Arrived nodes form cluster rings at center
  const numGroups = Math.ceil(arrived.length / GROUP_SIZE)
  const clusterCenters = groupCenters(numGroups)

  arrived.forEach((n, i) => {
    const groupIdx = Math.floor(i / GROUP_SIZE)
    const posInGroup = i % GROUP_SIZE
    const groupCount = Math.min(GROUP_SIZE, arrived.length - groupIdx * GROUP_SIZE)
    const center = clusterCenters[groupIdx] ?? { x: 0, y: 0 }
    const orbitR = NODE_R * 1.1
    const angle = (posInGroup / groupCount) * Math.PI * 2
    targets.set(n.id, {
      x: center.x + Math.cos(angle) * orbitR,
      y: center.y + Math.sin(angle) * orbitR,
    })
  })

  // In-flight nodes move inward along their angle as ETA approaches
  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    const orbitR = (remaining / MAX_ETA_MS) * WORLD_R
    targets.set(n.id, {
      x: Math.cos(n.angle) * orbitR,
      y: Math.sin(n.angle) * orbitR,
    })
  }

  return targets
}

// Centers for N groups arranged in a small ring around the origin
function groupCenters(count: number): Array<{ x: number; y: number }> {
  if (count === 0) return []
  if (count === 1) return [{ x: 0, y: 0 }]
  const ringR = NODE_R * 2.4 * (count <= 3 ? 1 : Math.sqrt(count - 1))
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR }
  })
}

// ---- drawing ---------------------------------------------------------------

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: Node[],
  pointer: PointerState | null,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  // Concentric guide rings
  ctx.strokeStyle = 'rgba(17,24,39,0.08)'
  ctx.lineWidth = 1
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Lines from center to committed in-flight nodes
  const now = Date.now()
  for (const n of nodes) {
    if (n.state !== 'committed') continue
    const remaining = n.arrivalAt == null ? MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    if (remaining > 0) {
      ctx.strokeStyle = 'rgba(17,24,39,0.14)'
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(n.x, n.y)
      ctx.stroke()
    }
  }

  drawNodes(ctx, canvas, nodes, pointer)

  ctx.restore()
}

function drawNodes(
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

  // Cut outline + ETA text out of layer so background shows through
  lctx.globalCompositeOperation = 'destination-out'
  lctx.lineWidth = 4
  lctx.strokeStyle = '#000'
  lctx.fillStyle = '#000'
  for (const n of nodes) {
    lctx.beginPath()
    lctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2)
    lctx.stroke()
  }
  lctx.font = '700 12px system-ui, sans-serif'
  lctx.textAlign = 'center'
  lctx.textBaseline = 'middle'
  const now = Date.now()
  for (const n of nodes) {
    if (n.state === 'committed' && n.arrivalAt != null) {
      const remaining = Math.max(0, n.arrivalAt - now)
      if (remaining > 0) {
        lctx.fillText(`${Math.ceil(remaining / 1000)}s`, n.x, n.y)
      }
    }
  }
  if (pointer?.node?.state === 'interested' && !pointer.dragging) {
    const held = Math.min(HOLD_MS, performance.now() - pointer.downAt)
    lctx.fillText(`${Math.round(etaFromHold(held) / 1000)}s`, pointer.node.x, pointer.node.y)
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function colorFor(state: NodeState): string {
  if (state === 'committed') return '#f59e0b'
  if (state === 'interested') return '#22c55e'
  return '#9ca3af'
}

// ---- helpers ---------------------------------------------------------------

function etaFromHold(holdMs: number): number {
  const t = Math.min(1, Math.max(0, holdMs / HOLD_MS))
  return MIN_ETA_MS + (MAX_ETA_MS - MIN_ETA_MS) * (1 - t * t)
}

function etaFromDistance(x: number, y: number): number {
  const r = Math.min(WORLD_R, Math.max(0, Math.hypot(x, y)))
  return (r / WORLD_R) * MAX_ETA_MS
}

function spawnTarget(canvas: HTMLCanvasElement, angle: number): { x: number; y: number } {
  const margin = NODE_R + 8
  const halfW = Math.max(margin, canvas.clientWidth / 2 - margin)
  const halfH = Math.max(margin, canvas.clientHeight / 2 - margin)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const maxR = Math.min(
    Math.abs(c) < 0.0001 ? Number.POSITIVE_INFINITY : halfW / Math.abs(c),
    Math.abs(s) < 0.0001 ? Number.POSITIVE_INFINITY : halfH / Math.abs(s),
  )
  const minR = WORLD_R + NODE_R + 8
  if (maxR <= minR) return { x: c * maxR, y: s * maxR }
  const scale = 72
  const maxExtra = maxR - minR
  const u = Math.random()
  const extra = -scale * Math.log(1 - u * (1 - Math.exp(-maxExtra / scale)))
  return { x: c * (minR + extra), y: s * (minR + extra) }
}

function logNode(n: Node) {
  const distance = Math.round(Math.hypot(n.x, n.y))
  const eta = n.arrivalAt == null ? null : Math.max(0, Math.ceil((n.arrivalAt - Date.now()) / 1000))
  console.log(`node ${n.id}: distance=${distance}px eta=${eta ?? 'n/a'}s state=${n.state}`)
}
