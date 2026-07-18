import { useEffect, useRef, useState } from 'react'

interface Props {
  active: boolean
  count?: number
}

interface Particle {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  spin: number
}

const PARTY_WEBP = 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f973/512.webp'

export function PartyBurst({ active, count = 22 }: Props) {
  const [particles, setParticles] = useState<Particle[]>([])
  const [loaded, setLoaded] = useState(false)
  const nextIdRef = useRef(1)

  useEffect(() => {
    const img = new Image()
    img.onload = () => setLoaded(true)
    img.onerror = () => setLoaded(false)
    img.src = PARTY_WEBP
  }, [])

  useEffect(() => {
    if (!active) return
    const width = window.innerWidth
    const height = window.innerHeight
    const spawned: Particle[] = Array.from({ length: count }, () => ({
      id: nextIdRef.current++,
      x: Math.random() * width,
      y: height + 40 + Math.random() * 40,
      vx: (Math.random() - 0.5) * 5,
      vy: -9 - Math.random() * 7,
      rot: Math.random() * 360,
      spin: (Math.random() - 0.5) * 7,
    }))
    setParticles(spawned)
  }, [active, count])

  useEffect(() => {
    if (particles.length === 0) return
    let raf = 0
    const gravity = 0.36
    const tick = () => {
      setParticles((prev) =>
        prev
          .map((p) => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            vy: p.vy + gravity,
            rot: p.rot + p.spin,
          }))
          .filter((p) => p.y < window.innerHeight + 140),
      )
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [particles.length])

  if (particles.length === 0) return null

  return (
    <div className="party-burst" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="party-particle"
          style={{ transform: `translate(${p.x}px, ${p.y}px) rotate(${p.rot}deg)` }}
        >
          {loaded ? <img src={PARTY_WEBP} alt="" /> : <span className="noto-emoji">🥳</span>}
        </span>
      ))}
    </div>
  )
}
