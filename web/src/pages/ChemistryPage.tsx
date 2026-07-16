// Chemistry sandbox — physics interactions with node fusion into cluster rings.
// Single mode:   all arrived nodes form one elastic group (grows with each arrival).
// Parallel mode: arrived nodes tile into fixed-size groups of `perGroup` each.

import { useEffect, useRef, useState } from 'react'
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
type GroupingMode = 'single' | 'parallel'

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
const WORLD_R = 300

export function ChemistryPage() {
  useForceTheme('light')
  const [mode, setMode] = useState<GroupingMode>('single')
  const [perGroup, setPerGroup] = useState(3)
  const modeRef = useRef<GroupingMode>('single')
  const perGroupRef = useRef(3)

  // Keep refs in sync so the canvas loop reads latest without re-binding
  modeRef.current = mode
  perGroupRef.current = perGroup

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
      pointerRef.current = {
        id: e.pointerId,
        node: hit(p.x, p.y),
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
      const dist = Math.hypot(p.x, p.y)
      if (dist > 1) ps.node.angle = Math.atan2(p.y, p.x)
      if (ps.node.state === 'committed') {
        ps.node.arrivalAt = Date.now() + etaFromDistance(p.x, p.y, WORLD_R)
        logNode(ps.node)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      const held = performance.now() - ps.downAt

      if (!ps.node) {
        const click = toWorld(e)
        const angle = angleFromCenter(click.x, click.y)
        const target = spawnOutsideRing(canvas, angle, WORLD_R, NODE_R)
        nodesRef.current.push({
          id: nextIdRef.current++,
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
      step(nodesRef.current, pointerRef.current, modeRef.current, perGroupRef.current)
      draw(ctx, canvas, nodesRef.current, pointerRef.current)
      const now = performance.now()
      if (now - lastLogRef.current > 1000) {
        lastLogRef.current = now
        nodesRef.current.filter((n) => n.state === 'committed').forEach(logNode)
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
        <div className="chem-controls">
          <button
            className={`chem-mode-btn ${mode === 'single' ? 'active' : ''}`}
            onClick={() => setMode('single')}
          >
            Single
          </button>
          <button
            className={`chem-mode-btn ${mode === 'parallel' ? 'active' : ''}`}
            onClick={() => setMode('parallel')}
          >
            Parallel
          </button>
          {mode === 'parallel' && (
            <label className="chem-slider-label">
              per group
              <input
                type="range"
                min={2}
                max={8}
                value={perGroup}
                onChange={(e) => setPerGroup(Number(e.target.value))}
              />
              {perGroup}
            </label>
          )}
        </div>
        Click empty: create. Click gray: interest. Hold green: commit. Drag gold: adjust ETA.
      </div>
    </main>
  )
}

// ---- simulation ------------------------------------------------------------

function step(
  nodes: Node[],
  pointer: PointerState | null,
  mode: GroupingMode,
  perGroup: number,
) {
  const now = Date.now()
  const committed = nodes.filter((n) => n.state === 'committed')
  const targets = computeGroupTargets(committed, now, mode, perGroup)

  for (const n of nodes) {
    if (pointer?.node === n && pointer.dragging) continue

    if (n.state === 'lurker' && n.targetX != null && n.targetY != null) {
      n.vx += (n.targetX - n.x) * 0.03
      n.vy += (n.targetY - n.y) * 0.03
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      if (Math.hypot(n.targetX - n.x, n.targetY - n.y) < 6) {
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
      const target = targets.get(n.id) ?? { x: 0, y: 0 }
      n.vx += (target.x - n.x) * 0.04
      n.vy += (target.y - n.y) * 0.04
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
    }
  }
}

function computeGroupTargets(
  committed: Node[],
  now: number,
  mode: GroupingMode,
  perGroup: number,
): Map<number, { x: number; y: number }> {
  const targets = new Map<number, { x: number; y: number }>()

  const arrived = committed.filter(
    (n) => n.arrivalAt != null && n.arrivalAt - now <= 0,
  )
  const inFlight = committed.filter(
    (n) => n.arrivalAt == null || n.arrivalAt - now > 0,
  )

  if (mode === 'single') {
    // One elastic group: all arrived nodes orbit the center together.
    // The orbit radius scales so nodes stay overlapping circles-of-circles.
    const count = arrived.length
    if (count > 0) {
      const orbitR = count === 1 ? 0 : NODE_R * 1.1
      arrived.forEach((n, i) => {
        const angle = count === 1 ? 0 : (i / count) * Math.PI * 2
        targets.set(n.id, { x: Math.cos(angle) * orbitR, y: Math.sin(angle) * orbitR })
      })
    }
  } else {
    // Parallel: tile into groups of `perGroup`. Each full (or partial) group
    // gets its own cluster center arranged in a ring around the origin.
    const numGroups = Math.max(1, Math.ceil(arrived.length / perGroup))
    const centers = groupCenters(numGroups, perGroup)
    arrived.forEach((n, i) => {
      const gi = Math.floor(i / perGroup)
      const li = i % perGroup
      const groupCount = Math.min(perGroup, arrived.length - gi * perGroup)
      const center = centers[gi] ?? { x: 0, y: 0 }
      const orbitR = groupCount === 1 ? 0 : NODE_R * 1.1
      const angle = groupCount === 1 ? 0 : (li / groupCount) * Math.PI * 2
      targets.set(n.id, {
        x: center.x + Math.cos(angle) * orbitR,
        y: center.y + Math.sin(angle) * orbitR,
      })
    })
  }

  // In-flight nodes move inward along their angle as ETA approaches
  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? SANDBOX_MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    const orbitR = (remaining / SANDBOX_MAX_ETA_MS) * WORLD_R
    targets.set(n.id, {
      x: Math.cos(n.angle) * orbitR,
      y: Math.sin(n.angle) * orbitR,
    })
  }

  return targets
}

// Arrange N group centers in a ring sized to fit `perGroup` node circles
function groupCenters(
  count: number,
  perGroup: number,
): Array<{ x: number; y: number }> {
  if (count === 0) return []
  if (count === 1) return [{ x: 0, y: 0 }]
  // Ring radius: enough separation so groups don't overlap each other
  const groupFootprint = NODE_R * (1 + 2 * Math.sin(Math.PI / Math.max(2, perGroup)))
  const ringR = Math.max(NODE_R * 2.8, groupFootprint * count / (2 * Math.PI) * 1.4)
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
  ctx.fillStyle = getCssVar('--bg', '#ffffff')
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  ctx.globalAlpha = 0.06
  ctx.strokeStyle = getCssVar('--text', '#111827')
  ctx.lineWidth = 1
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const now = Date.now()
  for (const n of nodes) {
    if (n.state !== 'committed') continue
    const remaining = n.arrivalAt == null ? SANDBOX_MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
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
    lctx.fillStyle = nodeColor(n.state)
    lctx.beginPath()
    lctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2)
    lctx.fill()
  }

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
    const held = Math.min(SANDBOX_HOLD_MS, performance.now() - pointer.downAt)
    lctx.fillText(
      `${Math.round(etaFromHold(held) / 1000)}s`,
      pointer.node.x,
      pointer.node.y,
    )
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}


