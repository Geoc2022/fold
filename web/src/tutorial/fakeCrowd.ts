import type { ParticipantView } from '../types'

export interface FakeCrowdNode {
  id: string
  state: 'lurker' | 'interested' | 'committed'
  arrivalAt: number | null
}

export interface FakeCrowdConfig {
  interestRate: number
  commitRate: number
  avgEtaSec: number
}

const DEFAULT_CONFIG: FakeCrowdConfig = {
  interestRate: 0.55,
  commitRate: 0.45,
  avgEtaSec: 14,
}

export function buildFakeCrowd(count: number): FakeCrowdNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `fake-${i + 1}`,
    state: 'lurker',
    arrivalAt: null,
  }))
}

export function advanceFakeCrowd(
  crowd: FakeCrowdNode[],
  now: number,
  dtSec: number,
  config: Partial<FakeCrowdConfig> = {},
) {
  const c = { ...DEFAULT_CONFIG, ...config }
  for (const n of crowd) {
    if (n.state === 'lurker' && Math.random() < c.interestRate * dtSec) {
      n.state = 'interested'
      continue
    }
    if (n.state === 'interested' && Math.random() < c.commitRate * dtSec) {
      n.state = 'committed'
      const etaSec = Math.max(3, Math.round(-c.avgEtaSec * Math.log(Math.max(0.001, Math.random()))))
      n.arrivalAt = now + etaSec * 1000
    }
  }
}

export function crowdAsParticipants(crowd: FakeCrowdNode[], now: number): ParticipantView[] {
  return crowd
    .filter((n) => n.state !== 'lurker')
    .map((n, i) => ({
      id: n.id,
      color: ['#0ea5e9', '#22c55e', '#f97316', '#e11d48'][i % 4],
      state: n.state === 'committed' ? 'committed' : 'interested',
      arrival_at: n.state === 'committed' ? n.arrivalAt : null,
      is_me: false,
      last_seen_at: now,
    }))
}
