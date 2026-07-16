export interface PolicyRule {
  id: string
  source: string
  enabled: boolean
}

export function newPolicyRule(source: string): PolicyRule {
  return { id: crypto.randomUUID(), source, enabled: true }
}
