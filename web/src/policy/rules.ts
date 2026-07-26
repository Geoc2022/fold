import { readJson } from '../storage'
import { DEFAULT_NOTIFICATION_POLICY_TEMPLATE_ID, NOTIFICATION_POLICY_TEMPLATES } from './templates'

export interface PolicyRule {
  id: string
  source: string
  enabled: boolean
}

export const HOME_RULES_KEY = 'fold.policy.home.rules'
export const DEFAULT_POLICY =
  NOTIFICATION_POLICY_TEMPLATES.find((template) => template.id === DEFAULT_NOTIFICATION_POLICY_TEMPLATE_ID)?.source
  ?? 'is_ready => notify "{title} is ready"'
const LEGACY_DEFAULT_POLICY = 'is_ready => notify "{title} is ready"'

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
  const loaded = readJson(HOME_RULES_KEY, fallbackRules())
  if (
    loaded.length === 1
    && loaded[0]?.source.trim() === LEGACY_DEFAULT_POLICY
    && loaded[0]?.enabled === true
  ) {
    return [{ ...loaded[0], source: DEFAULT_POLICY }]
  }
  return loaded
}

export function loadRoomRules(code: string): PolicyRule[] | null {
  return readJson<PolicyRule[] | null>(roomRulesKey(code), null)
}

export function effectiveRulesForCode(code: string, homeRules?: PolicyRule[]): PolicyRule[] {
  return loadRoomRules(code) ?? homeRules ?? loadHomeRules()
}
