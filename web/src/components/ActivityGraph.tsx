import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityView, Person } from '../types'

interface Props {
  activities: ActivityView[]
  me: Person
}

interface Node {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  color: string
  label: string
  status: string
  strength: number
}

const W = 640
const H = 260
const CX = 120
const CY = H / 2

function statusColor(a: ActivityView): string {
  if (a.my_state === 'committed') return '#22c55e'
  if (a.my_state === 'interested') return '#06b6d4'
  if (a.status === 'ready') return '#a3e635'
  if (a.status === 'scheduled') return '#818cf8'
  if (a.status === 'closed' || a.status === 'cancelled') return '#64748b'
  return '#cbd5e1'
}

function makeNodes(activities: ActivityView[]): Node[] {
  return activities.slice(0, 24).map((a, i) => {
    const angle = (i / Math.max(1, activities.length)) * Math.PI * 2
    const baseRadius = 9 + Math.min(14, a.committed_count * 2)
    return {
      id: a.id,
      x: 350 + Math.cos(angle) * 120 + (i % 3) * 24,
      y: CY + Math.sin(angle) * 84,
      vx: 0,
      vy: 0,
      radius: a.group.is_ready ? baseRadius + 5 : baseRadius,
      color: statusColor(a),
      label: a.title,
      status: a.status,
      strength: a.my_state === 'committed' ? 1 : a.my_state === 'interested' ? 0.65 : 0.28,
    }
  })
}

export function ActivityGraph({ activities, me }: Props) {
  const source = useMemo(() => activities.filter((a) => a.status !== 'cancelled'), [activities])
  const [nodes, setNodes] = useState<Node[]>(() => makeNodes(source))
  const nodesRef = useRef<Node[]>(nodes)

  useEffect(() => {
    nodesRef.current = reconcile(nodesRef.current, makeNodes(source))
    setNodes([...nodesRef.current])
  }, [source])

  useEffect(() => {
    let raf = 0
    let lastPaint = 0
    function tick(t: number) {
      simulate(nodesRef.current)
      // Paint at ~20fps; physics can run every frame but React need not.
      if (t - lastPaint > 50) {
        lastPaint = t
        setNodes(nodesRef.current.map((n) => ({ ...n })))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (source.length === 0) {
    return (
      <section className="graph card">
        <h2>Constellation</h2>
        <p className="empty">Propose or join something to light up the map.</p>
      </section>
    )
  }

  return (
    <section className="graph card">
      <div className="graph-head">
        <h2>Constellation</h2>
        <span className="hint">pull = your interest</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Activity graph">
        <defs>
          <radialGradient id="meGlow">
            <stop offset="0%" stopColor={me.color} stopOpacity="0.8" />
            <stop offset="100%" stopColor={me.color} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={CY} r="54" fill="url(#meGlow)" />
        <circle cx={CX} cy={CY} r="18" fill={me.color} />
        <text x={CX} y={CY + 36} textAnchor="middle" className="graph-label me-label">
          you
        </text>
        {nodes.map((n) => (
          <line
            key={`${n.id}-link`}
            x1={CX}
            y1={CY}
            x2={n.x}
            y2={n.y}
            className="graph-link"
            strokeOpacity={0.12 + n.strength * 0.5}
          />
        ))}
        {nodes.map((n) => (
          <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
            {(n.status === 'ready' || n.status === 'scheduled') && (
              <circle r={n.radius + 10} fill={n.color} opacity="0.12" />
            )}
            <circle r={n.radius} fill={n.color} className="graph-node" />
            <text y={n.radius + 16} textAnchor="middle" className="graph-label">
              {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
    </section>
  )
}

function reconcile(current: Node[], next: Node[]): Node[] {
  const byId = new Map(current.map((n) => [n.id, n]))
  return next.map((n) => {
    const old = byId.get(n.id)
    return old ? { ...n, x: old.x, y: old.y, vx: old.vx, vy: old.vy } : n
  })
}

function simulate(nodes: Node[]) {
  for (const n of nodes) {
    const targetX = 430 - n.strength * 145
    const targetY = CY
    n.vx += (targetX - n.x) * (0.003 + n.strength * 0.004)
    n.vy += (targetY - n.y) * 0.003
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const min = a.radius + b.radius + 22
      if (dist < min) {
        const push = ((min - dist) / dist) * 0.025
        a.vx -= dx * push
        a.vy -= dy * push
        b.vx += dx * push
        b.vy += dy * push
      }
    }
  }

  for (const n of nodes) {
    n.vx *= 0.88
    n.vy *= 0.88
    n.x = Math.min(W - 42, Math.max(185, n.x + n.vx))
    n.y = Math.min(H - 34, Math.max(34, n.y + n.vy))
  }
}
