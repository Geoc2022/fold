import { useEffect, useMemo, useRef } from 'react'
import { hashUnit } from '../hash'
import {
  DEFAULT_ETA_MIN,
  HOLD_MS,
  MAX_ETA_MIN,
  MIN_ETA_MIN,
  etaFromHold,
  nodeColor,
  visualState,
  type VisualConfig,
  type VisualNodeState,
} from '../nodeVisual'
import type { ActivityView, ParticipantView, Person } from '../types'

interface Props {
  activity: ActivityView
  participants: ParticipantView[]
  me: Person
  visual: VisualConfig
  onInterested: () => Promise<void>
  onCommit: (etaMinutes: number) => Promise<void>
  onAlert: (message: string) => void
}

interface SimNode {
  id: string
  state: VisualNodeState
  arrivalAt: number | null
  isMe: boolean
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  targetX?: number
  targetY?: number
}

interface PointerState {
  id: number
  node: SimNode | null
  startX: number
  startY: number
  downAt: number
  dragging: boolean
}

interface Camera { x: number; y: number; scale: number }

const WORLD_R = 280
const VOGEL_C = 28
const PHI_RECIP_SQ = 1 / (((1 + Math.sqrt(5)) / 2) ** 2)
const VOGEL_N_MIN = Math.ceil((WORLD_R / VOGEL_C) ** 2)

export function RoomCanvas({ activity, participants, me, visual, onInterested, onCommit, onAlert }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const pointerRef = useRef<PointerState | null>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const pinchRef = useRef<{ dist: number } | null>(null)
  const visualRef = useRef(visual)
  const activityRef = useRef(activity)
  const busyRef = useRef(false)
  visualRef.current = visual
  activityRef.current = activity

  const source = useMemo(() => {
    const now = Date.now()
    const hasMe = participants.some((p) => p.is_me)
    const rows = participants.map((p) => ({
      id: p.is_me ? `me-${me.id}` : p.id,
      state: visualState(p, now),
      arrivalAt: p.arrival_at,
      isMe: p.is_me,
    }))
    if (!hasMe) rows.push({ id: `me-${me.id}`, state: 'lurker' as const, arrivalAt: null, isMe: true })
    return rows
  }, [participants, me.id])

  useEffect(() => {
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]))
    nodesRef.current = source.map((s, i) => {
      const old = existing.get(s.id)
      if (old) return { ...old, ...s }
      const angle = hashUnit(s.id) * Math.PI * 2
      const n = VOGEL_N_MIN + i
      return {
        ...s,
        x: Math.cos(n * 2 * Math.PI * PHI_RECIP_SQ) * VOGEL_C * Math.sqrt(n),
        y: Math.sin(n * 2 * Math.PI * PHI_RECIP_SQ) * VOGEL_C * Math.sqrt(n),
        vx: 0,
        vy: 0,
        angle,
      }
    })
  }, [source])

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

    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect()
      const cam = cameraRef.current
      return {
        x: (cx - rect.left - rect.width / 2 - cam.x) / cam.scale,
        y: (cy - rect.top - rect.height / 2 - cam.y) / cam.scale,
      }
    }

    const hit = (x: number, y: number) => {
      const r = visualRef.current.nodeRadius
      for (let i = nodesRef.current.length - 1; i >= 0; i -= 1) {
        const n = nodesRef.current[i]
        if (Math.hypot(n.x - x, n.y - y) <= r + 4) return n
      }
      return null
    }

    const activePointers = new Map<number, PointerEvent>()

    const call = async (fn: () => Promise<void>) => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        await fn()
      } catch (err) {
        onAlert(err instanceof Error ? err.message : String(err))
      } finally {
        busyRef.current = false
      }
    }

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
      const node = hit(p.x, p.y)
      pointerRef.current = { id: e.pointerId, node: node?.isMe ? node : null, startX: p.x, startY: p.y, downAt: performance.now(), dragging: false }
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
      const p = toWorld(e.clientX, e.clientY)
      if (!ps.node) {
        const cam = cameraRef.current
        const rect = canvas.getBoundingClientRect()
        const sx = ps.startX * cam.scale + cam.x + rect.width / 2
        const sy = ps.startY * cam.scale + cam.y + rect.height / 2
        if (Math.hypot(e.clientX - rect.left - sx, e.clientY - rect.top - sy) > 6) {
          cam.x += (p.x - ps.startX) * cam.scale
          cam.y += (p.y - ps.startY) * cam.scale
        }
        return
      }

      if (ps.node.state !== 'committed' && ps.node.state !== 'arrived') return
      if (Math.hypot(p.x - ps.startX, p.y - ps.startY) > 6) ps.dragging = true
      ps.node.x = p.x
      ps.node.y = p.y
      ps.node.vx = 0
      ps.node.vy = 0
      if (Math.hypot(p.x, p.y) > 1) ps.node.angle = Math.atan2(p.y, p.x)
      ps.node.state = 'committed'
      ps.node.arrivalAt = Date.now() + etaFromDistance(p.x, p.y) * 60_000
    }

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) pinchRef.current = null
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      pointerRef.current = null
      if (!ps.node) return

      const held = performance.now() - ps.downAt
      if (ps.dragging && (ps.node.state === 'committed' || ps.node.state === 'arrived')) {
        const eta = etaFromDistance(ps.node.x, ps.node.y)
        void call(() => onCommit(eta))
        return
      }
      if (ps.node.state === 'lurker') {
        ps.node.state = 'interested'
        void call(onInterested)
      } else if (ps.node.state === 'interested' && held > 200) {
        const eta = etaFromHold(held)
        ps.node.state = 'committed'
        ps.node.arrivalAt = Date.now() + eta * 60_000
        void call(() => onCommit(eta))
      }
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

    let raf = 0
    let last = performance.now()
    const frame = () => {
      const now = Date.now()
      const perf = performance.now()
      const dt = Math.min(0.2, (perf - last) / 1000)
      last = perf
      for (const n of nodesRef.current) {
        if (n.state === 'committed' && n.arrivalAt != null && n.arrivalAt <= now) n.state = 'arrived'
      }
      step(nodesRef.current, pointerRef.current, activityRef.current, visualRef.current, now, dt)
      draw(ctx, canvas, nodesRef.current, pointerRef.current, cameraRef.current, visualRef.current, now)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [onAlert, onCommit, onInterested])

  return <canvas ref={canvasRef} className="room-canvas" />
}

function step(nodes: SimNode[], pointer: PointerState | null, activity: ActivityView, vis: VisualConfig, now: number, dt: number) {
  const targets = computeTargets(nodes, activity, vis, now)
  const arrived = nodes.filter((n) => n.state === 'arrived')
  for (const n of nodes) {
    if (pointer?.node === n && pointer.dragging) continue
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
    for (const src of arrived) {
      const dx = n.x - src.x
      const dy = n.y - src.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      if (dist < repulseR) {
        const force = ((repulseR - dist) / repulseR) * 0.6
        n.vx += (dx / dist) * force
        n.vy += (dy / dist) * force
      }
    }
    if (n.state === 'lurker') {
      n.vx += Math.cos(n.angle) * 2 * dt
      n.vy += Math.sin(n.angle) * 2 * dt
    }
    n.vx *= 0.88
    n.vy *= 0.88
    n.x += n.vx
    n.y += n.vy
  }
}

function computeTargets(nodes: SimNode[], activity: ActivityView, vis: VisualConfig, now: number) {
  const targets = new Map<string, { x: number; y: number }>()
  const committed = nodes.filter((n) => n.state === 'committed' || n.state === 'arrived')
  const arrived = committed.filter((n) => n.state === 'arrived')
  const inFlight = committed.filter((n) => n.state === 'committed')
  const groupSizes = activity.current_run?.group.group_sizes ?? []
  const orbitR = vis.nodeRadius * vis.clusterTightness

  if (activity.grouping_mode === 'single') {
    placeGroup(targets, arrived, { x: 0, y: 0 }, orbitR)
  } else {
    const groups = groupBySizes(arrived, groupSizes.length > 0 ? groupSizes : [arrived.length])
    const centers = groupCenters(groups.length, activity.group_multiple, orbitR)
    groups.forEach((group, i) => placeGroup(targets, group, centers[i] ?? { x: 0, y: 0 }, orbitR))
  }

  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? DEFAULT_ETA_MIN * 60_000 : Math.max(0, n.arrivalAt - now)
    const r = (remaining / (MAX_ETA_MIN * 60_000)) * WORLD_R
    targets.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r })
  }
  return targets
}

function placeGroup(targets: Map<string, { x: number; y: number }>, group: SimNode[], center: { x: number; y: number }, orbitR: number) {
  group.forEach((n, i) => {
    const r = group.length <= 1 ? 0 : orbitR
    const a = group.length <= 1 ? 0 : (i / group.length) * Math.PI * 2
    targets.set(n.id, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })
  })
}

function groupBySizes(nodes: SimNode[], sizes: number[]) {
  const groups: SimNode[][] = []
  let idx = 0
  for (const size of sizes) {
    groups.push(nodes.slice(idx, idx + size))
    idx += size
  }
  if (idx < nodes.length) groups.push(nodes.slice(idx))
  return groups.filter((g) => g.length > 0)
}

function groupCenters(count: number, perGroup: number, orbitR: number): Array<{ x: number; y: number }> {
  if (count <= 1) return [{ x: 0, y: 0 }]
  const ringR = Math.max(orbitR * 2.8, ((orbitR * 2 * count * Math.max(2, perGroup)) / (2 * Math.PI)) * 0.7)
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR }
  })
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: SimNode[],
  pointer: PointerState | null,
  camera: Camera,
  vis: VisualConfig,
  now: number,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = getCss('--bg')
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  ctx.scale(camera.scale, camera.scale)
  ctx.strokeStyle = getCss('--bg') === '#000000' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
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

  for (const n of nodes) {
    lctx.fillStyle = nodeColor(n.state)
    lctx.beginPath()
    lctx.arc(n.x, n.y, vis.nodeRadius, 0, Math.PI * 2)
    lctx.fill()
  }
  lctx.globalCompositeOperation = 'destination-out'
  if (vis.outlineWidth > 0) {
    lctx.lineWidth = vis.outlineWidth
    lctx.strokeStyle = '#000'
    for (const n of nodes) {
      lctx.beginPath()
      lctx.arc(n.x, n.y, vis.nodeRadius, 0, Math.PI * 2)
      lctx.stroke()
    }
  }

  const labelNode = pointer?.node && !pointer.dragging && pointer.node.state === 'interested'
    ? pointer.node
    : pointer?.node && pointer.dragging && (pointer.node.state === 'committed' || pointer.node.state === 'arrived')
      ? pointer.node
      : null
  if (labelNode) {
    lctx.globalCompositeOperation = 'source-over'
    const fs = Math.max(9, Math.round(vis.nodeRadius * 0.52))
    lctx.font = `700 ${fs}px Manrope, sans-serif`
    lctx.textAlign = 'center'
    lctx.textBaseline = 'middle'
    lctx.fillStyle = '#fff'
    const eta = labelNode.state === 'interested'
      ? etaFromHold(Math.min(HOLD_MS, performance.now() - pointer!.downAt))
      : etaRemainingMinutes(labelNode.arrivalAt, now)
    lctx.fillText(`${eta}m`, labelNode.x, labelNode.y)
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function etaFromDistance(x: number, y: number) {
  const t = Math.min(1, Math.max(0, Math.hypot(x, y) / WORLD_R))
  return Math.max(MIN_ETA_MIN, Math.min(MAX_ETA_MIN, Math.round(t * MAX_ETA_MIN)))
}

function etaRemainingMinutes(arrivalAt: number | null, now: number) {
  if (arrivalAt == null) return DEFAULT_ETA_MIN
  return Math.max(0, Math.ceil((arrivalAt - now) / 60000))
}

function getCss(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
