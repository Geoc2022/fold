import { readJson } from '../storage'

export interface PolicyRule {
  id: string
  source: string
  enabled: boolean
}

export const HOME_RULES_KEY = 'fold.policy.home.rules'
export const DEFAULT_POLICY = 'is_ready => notify "{title} is ready"'

export function newPolicyRule(source: string): PolicyRule {
  return { id: crypto.randomUUID(), source, enabled: true }
}

export function roomRulesKey(code: string): string {
  return `fold.policy.room.rules.${code.toUpperCase()}`
}

function fallbackRules(): PolicyRule[] {
  return [newPolicyRule(DEFAULT_POLICY)]
}

export function loadHomeRules(): PolicyRule[] {
  return readJson(HOME_RULES_KEY, fallbackRules())
}

export function loadRoomRules(code: string): PolicyRule[] | null {
  return readJson<PolicyRule[] | null>(roomRulesKey(code), null)
}

export function effectiveRulesForCode(code: string, homeRules?: PolicyRule[]): PolicyRule[] {
  return loadRoomRules(code) ?? homeRules ?? loadHomeRules()
}
