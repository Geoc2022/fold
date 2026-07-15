import { useEffect, useRef, useState } from 'react'
import type { ParticipantView } from '../types'

type NodeState = 'lurker' | 'interested' | 'committed' | 'arrived'
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
  vogelN: number
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

interface Camera { x: number; y: number; scale: number }

interface SimConfig {
  spawnPerSec: number
  interestRate: number
  commitRate: number
  avgEtaSec: number
  maxNodes: number
}

interface VisConfig {
  nodeRadius: number
  outlineWidth: number
  clusterTightness: number
}

export interface BiologySnapshot {
  now: number
  participants: ParticipantView[]
}

interface BiologyRoomProps {
  embedded?: boolean
  onSnapshot?: (snapshot: BiologySnapshot) => void
}

const HOLD_MS = 5_000
const MIN_ETA_MS = 0
const MAX_ETA_MS = 60 * 1000
const WORLD_R = 280
const MAX_NODES = 26
const VOGEL_C = 28
const PHI_RECIP_SQ = 1 / (((1 + Math.sqrt(5)) / 2) ** 2)
const VOGEL_N_MIN = Math.ceil((WORLD_R / VOGEL_C) ** 2)

export function BiologyRoom({ embedded = false, onSnapshot }: BiologyRoomProps) {
  const [running, setRunning] = useState(true)
  const [mode, setMode] = useState<GroupingMode>('single')
  const [perGroup, setPerGroup] = useState(3)
  const [sim, setSim] = useState<SimConfig>({
    spawnPerSec: 0.8,
    interestRate: 0.3,
    commitRate: 0.2,
    avgEtaSec: 30,
    maxNodes: MAX_NODES,
  })
  const [vis, setVis] = useState<VisConfig>({
    nodeRadius: 20,
    outlineWidth: 2,
    clusterTightness: 1.2,
  })

  const modeRef = useRef(mode)
  const perGroupRef = useRef(perGroup)
  const simRef = useRef(sim)
  const visRef = useRef(vis)
  const snapshotRef = useRef(onSnapshot)
  const runningRef = useRef(running)
  const lastSnapshotAtRef = useRef(0)
  modeRef.current = mode
  perGroupRef.current = perGroup
  simRef.current = sim
  visRef.current = vis
  snapshotRef.current = onSnapshot
  runningRef.current = running

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<Node[]>([])
  const nextIdRef = useRef(1)
  const vogelCounterRef = useRef(VOGEL_N_MIN)
  const pointerRef = useRef<PointerState | null>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const lastSimRef = useRef(performance.now())
  const spawnAccRef = useRef(0)
  const pinchRef = useRef<{ dist: number } | null>(null)

  function patchSim(p: Partial<SimConfig>) { setSim((prev) => ({ ...prev, ...p })) }
  function patchVis(p: Partial<VisConfig>) { setVis((prev) => ({ ...prev, ...p })) }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let didCenter = false

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!didCenter) {
        cameraRef.current.x = 0
        cameraRef.current.y = 0
        cameraRef.current.scale = 1
        didCenter = true
      }
    }
    resize()
    window.addEventListener('resize', resize)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(canvas)

    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect()
      const cam = cameraRef.current
      return {
        x: (cx - rect.left - rect.width / 2 - cam.x) / cam.scale,
        y: (cy - rect.top - rect.height / 2 - cam.y) / cam.scale,
      }
    }

    const hit = (x: number, y: number) => {
      const r = visRef.current.nodeRadius
      for (let i = nodesRef.current.length - 1; i >= 0; i -= 1) {
        const n = nodesRef.current[i]
        if (Math.hypot(n.x - x, n.y - y) <= r + 4) return n
      }
      return null
    }

    const activePointers = new Map<number, PointerEvent>()

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, e)
      canvas.setPointerCapture(e.pointerId)
      if (activePointers.size === 2) {
        const pts = [...activePointers.values()]
        pinchRef.current = { dist: Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY) }
        pointerRef.current = null
        return
      }
      const p = toWorld(e.clientX, e.clientY)
      pointerRef.current = { id: e.pointerId, node: hit(p.x, p.y), startX: p.x, startY: p.y, downAt: performance.now(), dragging: false }
    }

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, e)
      if (activePointers.size === 2 && pinchRef.current) {
        const pts = [...activePointers.values()]
        const newDist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY)
        cameraRef.current.scale = Math.min(4, Math.max(0.2, cameraRef.current.scale * (newDist / Math.max(1, pinchRef.current.dist))))
        pinchRef.current.dist = newDist
        return
      }
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      if (!ps.node) {
        const rect = canvas.getBoundingClientRect()
        const ex = e.clientX - rect.left - rect.width / 2
        const ey = e.clientY - rect.top - rect.height / 2
        if (Math.hypot(ex - (ps.startX + cameraRef.current.x), ey - (ps.startY + cameraRef.current.y)) > 6) {
          const p = toWorld(e.clientX, e.clientY)
          cameraRef.current.x += (p.x - ps.startX) * cameraRef.current.scale
          cameraRef.current.y += (p.y - ps.startY) * cameraRef.current.scale
        }
        return
      }
      const p = toWorld(e.clientX, e.clientY)
      if (Math.hypot(p.x - ps.startX, p.y - ps.startY) > 6) ps.dragging = true
      ps.node.x = p.x
      ps.node.y = p.y
      ps.node.vx = 0
      ps.node.vy = 0
      if (Math.hypot(p.x, p.y) > 1) ps.node.angle = Math.atan2(p.y, p.x)
      if (ps.node.state === 'committed' || ps.node.state === 'arrived') {
        ps.node.arrivalAt = Date.now() + etaFromDistance(p.x, p.y)
        if (ps.node.state === 'arrived' && ps.node.arrivalAt > Date.now()) ps.node.state = 'committed'
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) pinchRef.current = null
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      const held = performance.now() - ps.downAt
      if (!ps.node && !ps.dragging) {
        const p = toWorld(e.clientX, e.clientY)
        addNode(p.x, p.y, false)
      } else if (ps.node && !ps.dragging) {
        if (ps.node.state === 'lurker') ps.node.state = 'interested'
        else if (ps.node.state === 'interested' && held > 200) {
          ps.node.state = 'committed'
          ps.node.arrivalAt = Date.now() + etaFromHold(held)
        }
      }
      pointerRef.current = null
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cameraRef.current.scale = Math.min(4, Math.max(0.2, cameraRef.current.scale * (e.deltaY < 0 ? 1.08 : 0.92)))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    function addNode(wx: number, wy: number, simulated: boolean) {
      if (nodesRef.current.length >= MAX_NODES) return
      const angle = Math.hypot(wx, wy) < 0.001 ? -Math.PI / 2 : Math.atan2(wy, wx)
      const target = spawnTarget(canvas!, angle, visRef.current.nodeRadius)
      nodesRef.current.push({ id: nextIdRef.current, x: wx, y: wy, vx: 0, vy: 0, state: 'lurker', arrivalAt: null, targetX: target.x, targetY: target.y, angle, vogelN: vogelCounterRef.current, simulated })
      nextIdRef.current += 1
      vogelCounterRef.current += 1
    }

    function vogelSpawn() {
      const n = vogelCounterRef.current
      addNode(
        Math.cos(n * 2 * Math.PI * PHI_RECIP_SQ) * VOGEL_C * Math.sqrt(n),
        Math.sin(n * 2 * Math.PI * PHI_RECIP_SQ) * VOGEL_C * Math.sqrt(n),
        true,
      )
    }

    let raf = 0
    const frame = () => {
      const now = Date.now()
      const perf = performance.now()
      const dt = Math.min(0.2, (perf - lastSimRef.current) / 1000)
      lastSimRef.current = perf
      const c = simRef.current
      const nodes = nodesRef.current

      if (runningRef.current) {
        if (nodes.length >= Math.min(c.maxNodes, MAX_NODES)) {
          nodesRef.current = []
          vogelCounterRef.current = VOGEL_N_MIN
          spawnAccRef.current = 0
        }

        spawnAccRef.current += c.spawnPerSec * dt
        while (spawnAccRef.current >= 1) {
          vogelSpawn()
          spawnAccRef.current -= 1
        }

        for (const n of nodes) {
          if (!n.simulated) continue
          if (n.state === 'committed' && n.arrivalAt != null && n.arrivalAt <= now) n.state = 'arrived'
          if (n.state === 'lurker' && n.targetX == null && Math.random() < c.interestRate * dt) n.state = 'interested'
          else if (n.state === 'interested' && Math.random() < c.commitRate * dt) {
            n.state = 'committed'
            n.arrivalAt = now + Math.min(MAX_ETA_MS, Math.max(MIN_ETA_MS, -c.avgEtaSec * Math.log(Math.max(0.001, Math.random())) * 1000))
          }
        }
        for (const n of nodes) {
          if (n.state === 'committed' && n.arrivalAt != null && n.arrivalAt <= now) n.state = 'arrived'
        }

        step(nodes, pointerRef.current, modeRef.current, perGroupRef.current, visRef.current, now)
      }
      draw(ctx, canvas, nodes, cameraRef.current, visRef.current)

      const snapshotCb = snapshotRef.current
      if (snapshotCb && perf - lastSnapshotAtRef.current > 350) {
        lastSnapshotAtRef.current = perf
        snapshotCb({ now, participants: nodesToParticipants(nodes, now) })
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      window.removeEventListener('resize', resize)
      ro?.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [])

  const rootClass = embedded ? 'biology-room embedded' : 'biology-page'
  const helpClass = embedded ? 'biology-help bio-help embedded' : 'physics-help bio-help'

  return (
    <main className={rootClass}>
      <canvas ref={canvasRef} className="biology-canvas" />
      <button
        type="button"
        className="biology-play-toggle"
        onClick={() => setRunning((v) => !v)}
        title={running ? 'Pause simulation' : 'Play simulation'}
        aria-label={running ? 'Pause simulation' : 'Play simulation'}
      >
        <span className="noto-emoji" aria-hidden="true">{running ? '⏸️' : '▶️'}</span>
      </button>
      <div className={helpClass}>
        <div className="bio-section-title">Simulation</div>
        <div className="bio-sliders">
          <SR label="spawn/s" min={0} max={5} step={0.1} value={sim.spawnPerSec} fmt={(v) => v.toFixed(1)} onChange={(v) => patchSim({ spawnPerSec: v })} />
          <SR label="→ interested" min={0} max={1} step={0.05} value={sim.interestRate} fmt={(v) => `${Math.round(v * 100)}%/s`} onChange={(v) => patchSim({ interestRate: v })} />
          <SR label="→ committed" min={0} max={1} step={0.05} value={sim.commitRate} fmt={(v) => `${Math.round(v * 100)}%/s`} onChange={(v) => patchSim({ commitRate: v })} />
          <SR label="avg ETA" min={5} max={60} step={1} value={sim.avgEtaSec} fmt={(v) => `${v}s`} onChange={(v) => patchSim({ avgEtaSec: v })} />
          <SR label="max nodes" min={5} max={MAX_NODES} step={1} value={sim.maxNodes} fmt={(v) => String(v)} onChange={(v) => patchSim({ maxNodes: Math.min(MAX_NODES, v) })} />
          <div className="bio-slider-row">
            <span className="bio-slider-label">grouping</span>
            <div className="bio-mode-btns">
              <button className={`chem-mode-btn ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>Single</button>
              <button className={`chem-mode-btn ${mode === 'parallel' ? 'active' : ''}`} onClick={() => setMode('parallel')}>Parallel</button>
            </div>
          </div>
          {mode === 'parallel' && (
            <SR label="per group" min={2} max={8} step={1} value={perGroup} fmt={(v) => String(v)} onChange={(v) => setPerGroup(v)} />
          )}
        </div>

        <div className="bio-section-title">Visual</div>
        <div className="bio-sliders">
          <SR label="node size" min={6} max={50} step={1} value={vis.nodeRadius} fmt={(v) => `${v}px`} onChange={(v) => patchVis({ nodeRadius: v })} />
          <SR label="outline" min={0} max={12} step={0.5} value={vis.outlineWidth} fmt={(v) => `${v}px`} onChange={(v) => patchVis({ outlineWidth: v })} />
          <SR label="tightness" min={0} max={3} step={0.1} value={vis.clusterTightness} fmt={(v) => v.toFixed(1)} onChange={(v) => patchVis({ clusterTightness: v })} />
        </div>

        <span className="bio-hint">Click: create · Click gray: interest · Hold green: commit · Drag gold: ETA · Wheel/pinch: zoom</span>
      </div>
    </main>
  )
}

function SR({ label, min, max, step, value, fmt, onChange }: {
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
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="bio-slider-val">{fmt(value)}</span>
    </label>
  )
}

function step(
  nodes: Node[],
  pointer: PointerState | null,
  mode: GroupingMode,
  perGroup: number,
  vis: VisConfig,
  now: number,
) {
  const targets = computeGroupTargets(nodes, now, mode, perGroup, vis)
  const arrivedNodes = nodes.filter((n) => n.state === 'arrived')

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

    if (n.state === 'committed' || n.state === 'arrived') {
      const t = targets.get(n.id) ?? { x: 0, y: 0 }
      n.vx += (t.x - n.x) * 0.04
      n.vy += (t.y - n.y) * 0.04
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      continue
    }

    const repulseR = vis.nodeRadius * 6
    for (const src of arrivedNodes) {
      const dx = n.x - src.x
      const dy = n.y - src.y
      const dist = Math.max(1, Math.hypot(dx, dy))
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
  nodes: Node[],
  now: number,
  mode: GroupingMode,
  perGroup: number,
  vis: VisConfig,
) {
  const targets = new Map<number, { x: number; y: number }>()
  const committed = nodes.filter((n) => n.state === 'committed' || n.state === 'arrived')
  const arrived = committed.filter((n) => n.state === 'arrived')
  const inFlight = committed.filter((n) => n.state === 'committed')
  const orbitR = vis.nodeRadius * vis.clusterTightness

  if (mode === 'single') {
    arrived.forEach((n, i) => {
      const r = arrived.length <= 1 ? 0 : orbitR
      const a = arrived.length <= 1 ? 0 : (i / arrived.length) * Math.PI * 2
      targets.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r })
    })
  } else {
    const numGroups = Math.max(1, Math.ceil(arrived.length / perGroup))
    const centers = groupCenters(numGroups, perGroup, orbitR)
    arrived.forEach((n, i) => {
      const gi = Math.floor(i / perGroup)
      const li = i % perGroup
      const gc = Math.min(perGroup, arrived.length - gi * perGroup)
      const center = centers[gi] ?? { x: 0, y: 0 }
      const r = gc <= 1 ? 0 : orbitR
      const a = gc <= 1 ? 0 : (li / gc) * Math.PI * 2
      targets.set(n.id, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })
    })
  }

  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? MAX_ETA_MS : Math.max(0, n.arrivalAt - now)
    const r = (remaining / MAX_ETA_MS) * WORLD_R
    targets.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r })
  }
  return targets
}

function groupCenters(count: number, perGroup: number, orbitR: number): Array<{ x: number; y: number }> {
  if (count <= 1) return [{ x: 0, y: 0 }]
  const ringR = Math.max(orbitR * 2.8, (((orbitR * 2 * count * Math.max(2, perGroup)) / (2 * Math.PI)) * 0.7))
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR }
  })
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: Node[],
  camera: Camera,
  vis: VisConfig,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  ctx.scale(camera.scale, camera.scale)

  const ringAlpha = 0.02
  ctx.strokeStyle = `rgba(17,24,39,${ringAlpha})`
  ctx.lineWidth = 1 / camera.scale
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()

  const dpr = canvas.width / Math.max(1, w)
  const layer = document.createElement('canvas')
  layer.width = canvas.width
  layer.height = canvas.height
  const lctx = layer.getContext('2d')
  if (!lctx) return

  lctx.scale(dpr, dpr)
  lctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  lctx.scale(camera.scale, camera.scale)

  const nr = vis.nodeRadius
  lctx.globalCompositeOperation = 'source-over'
  for (const n of nodes) {
    lctx.fillStyle = colorFor(n.state)
    lctx.beginPath()
    lctx.arc(n.x, n.y, nr, 0, Math.PI * 2)
    lctx.fill()
  }

  lctx.globalCompositeOperation = 'destination-out'
  lctx.strokeStyle = '#000'
  lctx.fillStyle = '#000'
  if (vis.outlineWidth > 0) {
    lctx.lineWidth = vis.outlineWidth
    for (const n of nodes) {
      lctx.beginPath()
      lctx.arc(n.x, n.y, nr, 0, Math.PI * 2)
      lctx.stroke()
    }
  }

  lctx.globalCompositeOperation = 'source-over'
  lctx.fillStyle = '#0f172a'
  lctx.textAlign = 'center'
  lctx.textBaseline = 'middle'
  lctx.font = `700 ${Math.max(11, Math.round(nr * 0.65))}px ui-monospace, SFMono-Regular, Menlo, monospace`
  for (const n of nodes) {
    lctx.fillText(nodeLabel(n.id), n.x, n.y)
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function colorFor(state: NodeState) {
  if (state === 'arrived') return '#ef4444'
  if (state === 'committed') return '#f59e0b'
  if (state === 'interested') return '#22c55e'
  return '#9ca3af'
}

function etaFromHold(holdMs: number) {
  const t = Math.min(1, Math.max(0, holdMs / HOLD_MS))
  return MIN_ETA_MS + (MAX_ETA_MS - MIN_ETA_MS) * (1 - t * t)
}

function nodeLabel(id: number) {
  const base = 'A'.charCodeAt(0)
  return String.fromCharCode(base + ((id - 1) % MAX_NODES))
}

function etaFromDistance(x: number, y: number) {
  return (Math.min(WORLD_R, Math.max(0, Math.hypot(x, y))) / WORLD_R) * MAX_ETA_MS
}

function spawnTarget(canvas: HTMLCanvasElement, angle: number, nodeR: number) {
  const margin = nodeR + 8
  const halfW = Math.max(margin, canvas.clientWidth / 2 - margin)
  const halfH = Math.max(margin, canvas.clientHeight / 2 - margin)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const maxR = Math.min(
    Math.abs(c) < 0.0001 ? Infinity : halfW / Math.abs(c),
    Math.abs(s) < 0.0001 ? Infinity : halfH / Math.abs(s),
  )
  const minR = WORLD_R + nodeR + 8
  if (maxR <= minR) return { x: c * maxR, y: s * maxR }
  const scale = 72
  const maxExtra = maxR - minR
  const u = Math.random()
  const extra = -scale * Math.log(1 - u * (1 - Math.exp(-maxExtra / scale)))
  return { x: c * (minR + extra), y: s * (minR + extra) }
}

function nodesToParticipants(nodes: Node[], now: number): ParticipantView[] {
  return nodes
    .filter((n) => n.state !== 'lurker')
    .map((n) => ({
      id: `bio-${n.id}`,
      color: colorFor(n.state),
      state: n.state === 'interested' ? 'interested' : 'committed',
      arrival_at: n.state === 'interested' ? null : (n.arrivalAt ?? now),
      is_me: false,
    }))
}
