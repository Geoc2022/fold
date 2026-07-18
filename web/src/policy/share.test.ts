import { describe, expect, it } from 'vitest'
import type { PolicyRule } from './rules'
import { appendPolicySources, decodePolicySources, encodePolicySources } from './share'

const existing: PolicyRule = { id: 'existing', source: 'is_ready => notify "yo"', enabled: true }

describe('shared policies', () => {
  it('round-trips Unicode policy sources', () => {
    const rules = [existing, { id: 'unicode', source: 'is_ready => notify "ready 🎲"', enabled: true }]
    expect(decodePolicySources(encodePolicySources(rules))).toEqual(rules.map((rule) => rule.source))
  })

  it('appends new sources without duplicating existing rules', () => {
    const result = appendPolicySources([existing], [existing.source, 'is_interested => notify "join"'])
    expect(result.map((rule) => rule.source)).toEqual([existing.source, 'is_interested => notify "join"'])
  })
})
