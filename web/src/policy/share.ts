import { newPolicyRule, type PolicyRule } from './rules'

export function encodePolicySources(rules: PolicyRule[]): string {
  const text = JSON.stringify(rules.map((rule) => rule.source))
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function decodePolicySources(encoded: string): string[] {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((source): source is string => typeof source === 'string')
}

export function appendPolicySources(rules: PolicyRule[], sources: string[]): PolicyRule[] {
  const existing = new Set(rules.map((rule) => rule.source))
  const additions: PolicyRule[] = []
  for (const source of sources) {
    if (existing.has(source)) continue
    existing.add(source)
    additions.push(newPolicyRule(source))
  }
  return additions.length > 0 ? [...rules, ...additions] : rules
}
