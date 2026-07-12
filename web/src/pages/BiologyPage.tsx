// Biology sandbox — chemistry mechanics + automatic user simulation.
//
// Visual goals:
//   - In-flight committed nodes have slight repulsion away from arrived groups.
//   - Arrived groups have gravity toward the center (they stay put, effectively).
//   - No line from node to center.
//   - No ETA countdown unless the user is actively dragging that node.
//   - Background rings fade out when the user is not dragging anything.
//
// Simulation: nodes spawn automatically on Vogel's phyllotaxis spiral just
// outside the commit-time boundary, then probabilistically become interested
// and then committed at rates controlled by the UI.

import { useEffect, useRef, useState } from 'react'

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
  // spawn-fly-out animation target
  targetX?: number
  targetY?: number
  // stable directional angle from center (for inward commit path)
  angle: number
  // which Vogel index this node was born at (for spiral determinism)
  vogelN: number
  // true = created by the simulation, false = user-created
  simulated: boolean
}

interface PointerState {
  id: number
  node: Node | null
  startX: number
  startY: number
  downAt: number
  dragging: boolean
}

interface SimConfig {
  spawnPerSec: number      // new nodes per second
  interestRate: number     // probability per second a lurker becomes interested
  commitRate: number       // probability per second an interested node commits
  avgEtaSec: number        // mean commit ETA in seconds (exponential distribution)
  maxNodes: number         // total nodes before simulation clears and restarts
}

const NODE_R = 22
const HOLD_MS = 5_000
const MIN_ETA_MS = 0
const MAX_ETA_MS = 60 * 1000
const WORLD_R = 280          // max commit-time orbit radius
const VOGEL_C = 28           // spiral scale constant (pixels per sqrt(n))
const PHI_RECIP_SQ = 1 / (((1 + Math.sqrt(5)) / 2) ** 2)  // 1/φ²

// The innermost Vogel index where r >= WORLD_R (so we don't spawn inside the rings)
const VOGEL_N_MIN = Math.ceil((WORLD_R / VOGEL_C) ** 2)

export function BiologyPage() {
  const [mode, setMode] = useState<GroupingMode>('single')
  const [perGroup, setPerGroup] = useState(3)
  const [cfg, setCfg] = useState<SimConfig>({
    spawnPerSec: 0.8,
    interestRate: 0.3,
    commitRate: 0.2,
    avgEtaSec: 30,
    maxNodes: 40,
  })

  const modeRef = useRef<GroupingMode>('single')
  const perGroupRef = useRef(3)
  const cfgRef = useRef<SimConfig>(cfg)
  modeRef.current = mode
  perGroupRef.current = perGroup
  cfgRef.current = cfg

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<Node[]>([])
  const nextIdRef = useRef(1)
  const vogelCounterRef = useRef(VOGEL_N_MIN)
  const pointerRef = useRef<PointerState | null>(null)
  const lastSimRef = useRef(performance.now())
  const spawnAccRef = useRef(0)

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

    // ---- pointer interaction (manual nodes) --------------------------------

    const toWorld = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      }
    }

    const hit = (x: number, y: number) => {
      for (let i = nodesRef.current.length - 1; i >= 0; i--) {
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
        ps.node.arrivalAt = Date.now() + etaFromDistance(p.x, p.y)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      const held = performance.now() - ps.downAt
      if (!ps.node) {
        const click = toWorld(e)
        addNode(click.x, click.y, false)
      } else if (!ps.dragging) {
        if (ps.node.state === 'lurker') {
          ps.node.state = 'interested'
        } else if (ps.node.state === 'interested' && held > 200) {
          ps.node.state = 'committed'
          ps.node.arrivalAt = Date.now() + etaFromHold(held)
        }
      }
      pointerRef.current = null
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    // ---- helpers -----------------------------------------------------------

    function addNode(wx: number, wy: number, simulated: boolean) {
      const angle =
        Math.hypot(wx, wy) < 0.001 ? -Math.PI / 2 : Math.atan2(wy, wx)
      const target = spawnTarget(canvas!, angle)
      nodesRef.current.push({
        id: nextIdRef.current++,
        x: wx,
        y: wy,
        vx: 0,
        vy: 0,
        state: 'lurker',
        arrivalAt: null,
        targetX: target.x,
        targetY: target.y,
        angle,
        vogelN: vogelCounterRef.current++,
        simulated,
      })
    }

    function vogelSpawn() {
      const n = vogelCounterRef.current
      const r = VOGEL_C * Math.sqrt(n)
      const theta = n * 2 * Math.PI * PHI_RECIP_SQ
      addNode(Math.cos(theta) * r, Math.sin(theta) * r, true)
    }

    // ---- main loop ---------------------------------------------------------

    let raf = 0
    const frame = () => {
      const now = Date.now()
      const perf = performance.now()
      const dt = Math.min(0.2, (perf - lastSimRef.current) / 1000) // seconds
      lastSimRef.current = perf

      const c = cfgRef.current
      const nodes = nodesRef.current

      // Restart if over limit
      if (nodes.length >= c.maxNodes) {
        nodesRef.current = []
        vogelCounterRef.current = VOGEL_N_MIN
        spawnAccRef.current = 0
      }

      // Spawn simulated nodes
      spawnAccRef.current += c.spawnPerSec * dt
      while (spawnAccRef.current >= 1) {
        vogelSpawn()
        spawnAccRef.current -= 1
      }

      // State transitions for simulated nodes
      for (const n of nodes) {
        if (!n.simulated) continue
        if (n.state === 'lurker' && n.targetX == null) {
          if (Math.random() < c.interestRate * dt) n.state = 'interested'
        } else if (n.state === 'interested') {
          if (Math.random() < c.commitRate * dt) {
            n.state = 'committed'
            // Exponential ETA distribution around avgEtaSec
            const etaSec = -c.avgEtaSec * Math.log(Math.max(0.001, Math.random()))
            n.arrivalAt = now + Math.min(MAX_ETA_MS, Math.max(MIN_ETA_MS, etaSec * 1000))
          }
        }
      }

      const isDragging = pointerRef.current?.dragging ?? false

      step(nodesRef.current, pointerRef.current, modeRef.current, perGroupRef.current)
      draw(ctx, canvas, nodesRef.current, pointerRef.current, isDragging)
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

  function update(patch: Partial<SimConfig>) {
    setCfg((prev) => ({ ...prev, ...patch }))
  }

  return (
    <main className="biology-page">
      <canvas ref={canvasRef} className="physics-canvas" />
      <div className="physics-help bio-help">
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

        <div className="bio-sliders">
          <SliderRow
            label="spawn/s"
            min={0}
            max={5}
            step={0.1}
            value={cfg.spawnPerSec}
            fmt={(v) => v.toFixed(1)}
            onChange={(v) => update({ spawnPerSec: v })}
          />
          <SliderRow
            label="→ interested"
            min={0}
            max={1}
            step={0.05}
            value={cfg.interestRate}
            fmt={(v) => `${Math.round(v * 100)}%/s`}
            onChange={(v) => update({ interestRate: v })}
          />
          <SliderRow
            label="→ committed"
            min={0}
            max={1}
            step={0.05}
            value={cfg.commitRate}
            fmt={(v) => `${Math.round(v * 100)}%/s`}
            onChange={(v) => update({ commitRate: v })}
          />
          <SliderRow
            label="avg ETA"
            min={5}
            max={60}
            step={1}
            value={cfg.avgEtaSec}
            fmt={(v) => `${v}s`}
            onChange={(v) => update({ avgEtaSec: v })}
          />
          <SliderRow
            label="max nodes"
            min={5}
            max={100}
            step={5}
            value={cfg.maxNodes}
            fmt={(v) => String(v)}
            onChange={(v) => update({ maxNodes: v })}
          />
        </div>

        <span className="bio-hint">
          Click empty: create. Click gray: interested. Hold green: commit. Drag gold: adjust ETA.
        </span>
      </div>
    </main>
  )
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  fmt,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  fmt: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="bio-slider-row">
      <span className="bio-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="bio-slider-val">{fmt(value)}</span>
    </label>
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

  // Centers of arrived groups (used for repulsion of in-flight nodes)
  const arrivedCenters = arrivedGroupCenters(committed, now, mode, perGroup)

  for (const n of nodes) {
    if (pointer?.node === n && pointer.dragging) continue

    // Spawn fly-out animation
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
      continue
    }

    // Lurker/interested: repulsion from arrived group centers
    for (const c of arrivedCenters) {
      const dx = n.x - c.x
      const dy = n.y - c.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const repulseR = NODE_R * 5
      if (dist < repulseR) {
        const force = ((repulseR - dist) / repulseR) * 0.6
        n.vx += (dx / dist) * force
        n.vy += (dy / dist) * force
      }
    }
    n.vx *= 0.88
    n.vy *= 0.88
    n.x += n.vx
    n.y += n.vy
  }
}

function computeGroupTargets(
  committed: Node[],
  now: number,
  mode: GroupingMode,
  perGroup: number,
): Map<number, { x: number; y: number }> {
  const targets = new Map<number, { x: number; y: number }>()
  const arrived = committed.filter((n) => n.arrivalAt != null && n.arrivalAt <= now)
  const inFlight = committed.filter((n) => n.arrivalAt == null || n.arrivalAt > now)

  if (mode === 'single') {
    const count = arrived.length
    arrived.forEach((n, i) => {
      const orbitR = count <= 1 ? 0 : NODE_R * 1.1
      const angle = count <= 1 ? 0 : (i / count) * Math.PI * 2
      targets.set(n.id, { x: Math.cos(angle) * orbitR, y: Math.sin(angle) * orbitR })
    })
  } else {
    const numGroups = Math.max(1, Math.ceil(arrived.length / perGroup))
    const centers = groupCenters(numGroups, perGroup)
    arrived.forEach((n, i) => {
      const gi = Math.floor(i / perGroup)
      const li = i % perGroup
      const groupCount = Math.min(perGroup, arrived.length - gi * perGroup)
      const center = centers[gi] ?? { x: 0, y: 0 }
      const orbitR = groupCount <= 1 ? 0 : NODE_R * 1.1
      const angle = groupCount <= 1 ? 0 : (li / groupCount) * Math.PI * 2
      targets.set(n.id, {
        x: center.x + Math.cos(angle) * orbitR,
        y: center.y + Math.sin(angle) * orbitR,
      })
    })
  }

  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    const r = (remaining / MAX_ETA_MS) * WORLD_R
    targets.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r })
  }

  return targets
}

// Returns the center point(s) of arrived clusters (for repulsion)
function arrivedGroupCenters(
  committed: Node[],
  now: number,
  mode: GroupingMode,
  perGroup: number,
): Array<{ x: number; y: number }> {
  const arrived = committed.filter((n) => n.arrivalAt != null && n.arrivalAt <= now)
  if (arrived.length === 0) return []
  if (mode === 'single') return [{ x: 0, y: 0 }]
  const numGroups = Math.max(1, Math.ceil(arrived.length / perGroup))
  return groupCenters(numGroups, perGroup)
}

function groupCenters(
  count: number,
  perGroup: number,
): Array<{ x: number; y: number }> {
  if (count === 0) return []
  if (count === 1) return [{ x: 0, y: 0 }]
  const groupFootprint = NODE_R * (1 + 2 * Math.sin(Math.PI / Math.max(2, perGroup)))
  const ringR = Math.max(NODE_R * 2.8, (groupFootprint * count) / (2 * Math.PI) * 1.4)
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
  isDragging: boolean,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  // Background rings — fade out when not dragging
  const ringAlpha = isDragging ? 0.08 : 0.02
  ctx.strokeStyle = `rgba(17,24,39,${ringAlpha})`
  ctx.lineWidth = 1
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  drawNodes(ctx, canvas, nodes, pointer, isDragging)
  ctx.restore()
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: Node[],
  pointer: PointerState | null,
  isDragging: boolean,
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

  lctx.globalCompositeOperation = 'destination-out'
  lctx.lineWidth = 4
  lctx.strokeStyle = '#000'
  lctx.fillStyle = '#000'
  for (const n of nodes) {
    lctx.beginPath()
    lctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2)
    lctx.stroke()
  }

  // ETA countdown only on the node the user is actively dragging
  const draggedNode = isDragging ? pointer?.node : null
  if (draggedNode?.state === 'committed' && draggedNode.arrivalAt != null) {
    lctx.font = '700 12px system-ui, sans-serif'
    lctx.textAlign = 'center'
    lctx.textBaseline = 'middle'
    const remaining = Math.max(0, draggedNode.arrivalAt - Date.now())
    lctx.fillText(`${Math.ceil(remaining / 1000)}s`, draggedNode.x, draggedNode.y)
  }
  // Also show ETA while holding down on an interested node (pre-commit preview)
  if (pointer?.node?.state === 'interested' && !isDragging && pointer.dragging === false) {
    const held = Math.min(HOLD_MS, performance.now() - pointer.downAt)
    if (held > 50) {
      lctx.font = '700 12px system-ui, sans-serif'
      lctx.textAlign = 'center'
      lctx.textBaseline = 'middle'
      lctx.fillText(
        `${Math.round(etaFromHold(held) / 1000)}s`,
        pointer.node.x,
        pointer.node.y,
      )
    }
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
