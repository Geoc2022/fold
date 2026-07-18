import { describe, expect, it } from 'vitest'
import { policyCommitEta } from './commit'

describe('policyCommitEta', () => {
  it('uses the default ETA for bare commit', () => {
    expect(policyCommitEta({ max_commit_seconds: 3600, my_state: null, my_arrival_at: null }, null, 0)).toBe(1800)
  })

  it('adjusts the current committed ETA', () => {
    const activity = { max_commit_seconds: 3600, my_state: 'committed' as const, my_arrival_at: 600_000 }
    expect(policyCommitEta(activity, 180, 0)).toBe(780)
    expect(policyCommitEta(activity, -180, 0)).toBe(420)
  })

  it('clamps adjustments to the room bounds', () => {
    const activity = { max_commit_seconds: 300, my_state: null, my_arrival_at: null }
    expect(policyCommitEta(activity, 60, 0)).toBe(300)
    expect(policyCommitEta(activity, -600, 0)).toBe(0)
  })
})
