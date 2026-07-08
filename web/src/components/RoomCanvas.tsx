import { useEffect, useMemo, useRef } from 'react'
import type { ActivityView, ParticipantView, Person } from '../types'

interface Props {
  activity: ActivityView
  participants: ParticipantView[]
  me: Person
  theme: 'light' | 'dark'
}

interface SimNode {
  id: string
  color: string
  state: 'lurker' | 'interested' | 'committed'
  arrival_at: number | null
  is_me: boolean
  x: number
  y: number
  vx: number
  vy: number
  alpha: number
}

const FADE_AFTER_MS = 10 * 60 * 1000
const MAX_ETA_MS = 30 * 60 * 1000

export function RoomCanvas({ activity, participants, me, theme }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const cameraRef = useRef({ x: 0, y: 0, scale: 1, dragging: false, px: 0, py: 0 })

  const source = useMemo(() => {
    const hasMe = participants.some((p) => p.is_me)
    const nodes: Array<Pick<SimNode, 'id' | 'color' | 'state' | 'arrival_at' | 'is_me'>> = participants.map((p) => ({
      id: p.id,
      color: stateColor(p.state),
      state: p.state,
      arrival_at: p.arrival_at,
      is_me: p.is_me,
    }))
    if (!hasMe) {
      nodes.push({
        id: `lurker-${me.id}`,
        color: stateColor('lurker'),
        state: 'lurker' as const,
        arrival_at: null,
        is_me: true,
      })
    }
    return nodes
  }, [participants, me.id, theme])

  useEffect(() => {
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]))
    nodesRef.current = source.map((s, i) => {
      const old = existing.get(s.id)
      if (old) return { ...old, ...s }
      const angle = hashAngle(s.id)
      const radius = 260 + (i % 5) * 18
      return {
        ...s,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        alpha: 1,
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

    const onPointerDown = (e: PointerEvent) => {
      cameraRef.current.dragging = true
      cameraRef.current.px = e.clientX
      cameraRef.current.py = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      const cam = cameraRef.current
      if (!cam.dragging) return
      cam.x += e.clientX - cam.px
      cam.y += e.clientY - cam.py
      cam.px = e.clientX
      cam.py = e.clientY
    }
    const onPointerUp = () => {
      cameraRef.current.dragging = false
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const cam = cameraRef.current
      const factor = e.deltaY < 0 ? 1.08 : 0.92
      cam.scale = Math.min(2.2, Math.max(0.45, cam.scale * factor))
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let raf = 0
    const frame = () => {
      draw(ctx, canvas, activity, nodesRef.current, cameraRef.current, Date.now(), theme)
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
  }, [activity, theme])

  return <canvas ref={canvasRef} className="room-canvas" />
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  activity: ActivityView,
  nodes: SimNode[],
  camera: { x: number; y: number; scale: number },
  now: number,
  theme: 'light' | 'dark',
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = theme === 'light' ? '#ffffff' : '#0b0d12'
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  ctx.scale(camera.scale, camera.scale)

  ctx.strokeStyle = theme === 'light' ? 'rgba(17,24,39,0.07)' : 'rgba(231,235,243,0.08)'
  for (let r = 80; r <= 360; r += 70) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.fillStyle = theme === 'light' ? '#111827' : '#f8fafc'
  ctx.font = '600 22px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(activity.title, 0, -18)
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillStyle = theme === 'light' ? '#6b7280' : '#96a0b5'
  ctx.fillText(roomSubtitle(activity), 0, 7)

  const targets = computeTargets(activity, nodes, now)
  for (const n of nodes) {
    const target = targets.get(n.id) ?? { x: 0, y: 260 }
    const mass = n.state === 'committed' ? 0.035 : n.state === 'interested' ? 0.018 : 0.006
    n.vx += (target.x - n.x) * mass
    n.vy += (target.y - n.y) * mass
    n.vx *= 0.9
    n.vy *= 0.9
    n.x += n.vx
    n.y += n.vy
    n.alpha = nodeAlpha(n, now)
  }

  for (const n of nodes) {
    if (n.alpha <= 0.02) continue
    const radius = 14
    ctx.globalAlpha = n.alpha
    ctx.beginPath()
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = n.color
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()
}

function computeTargets(activity: ActivityView, nodes: SimNode[], now: number) {
  const targets = new Map<string, { x: number; y: number }>()
  const committed = nodes.filter((n) => n.state === 'committed')
  const placed = activity.group.group_sizes.reduce((a, b) => a + b, 0)
  const clusterCenters = clusterCentersFor(activity.group.group_sizes.length)

  committed.forEach((n, i) => {
    if (i < placed && activity.group.group_sizes.length > 0) {
      const groupIndex = groupIndexFor(activity.group.group_sizes, i)
      const center = clusterCenters[groupIndex] ?? { x: 0, y: 0 }
      const local = i - activity.group.group_sizes.slice(0, groupIndex).reduce((a, b) => a + b, 0)
      const angle = (local / Math.max(1, activity.group.group_sizes[groupIndex])) * Math.PI * 2
      targets.set(n.id, {
        x: center.x + Math.cos(angle) * 9,
        y: center.y + Math.sin(angle) * 9,
      })
      return
    }
    const remaining = n.arrival_at == null ? MAX_ETA_MS : Math.max(0, n.arrival_at - now)
    const radius = 42 + Math.min(1, remaining / MAX_ETA_MS) * 220
    const angle = hashAngle(n.id)
    targets.set(n.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })

  for (const n of nodes) {
    if (targets.has(n.id)) continue
    const angle = hashAngle(n.id)
    const radius = n.state === 'interested' ? 210 : 310
    targets.set(n.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  return targets
}

function clusterCentersFor(count: number) {
  if (count <= 1) return [{ x: 0, y: 46 }]
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2
    return { x: Math.cos(angle) * 42, y: 46 + Math.sin(angle) * 42 }
  })
}

function groupIndexFor(sizes: number[], idx: number) {
  let seen = 0
  for (let i = 0; i < sizes.length; i += 1) {
    seen += sizes[i]
    if (idx < seen) return i
  }
  return sizes.length - 1
}

function nodeAlpha(n: SimNode, now: number) {
  if (n.state !== 'committed' || n.arrival_at == null) return 1
  const age = now - n.arrival_at
  if (age <= 0) return 1
  return Math.max(0, 1 - age / FADE_AFTER_MS)
}

function hashAngle(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h / 0xffffffff) * Math.PI * 2
}

function stateColor(state: 'lurker' | 'interested' | 'committed') {
  if (state === 'committed') return '#f59e0b'
  if (state === 'interested') return '#22c55e'
  return '#9ca3af'
}

function roomSubtitle(a: ActivityView) {
  if (a.status === 'ready') return 'group ready'
  if (a.group.spots_to_next != null) return `${a.group.spots_to_next} more to form`
  return a.status
}
