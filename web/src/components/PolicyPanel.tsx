import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightPolicy, type HighlightToken } from '../policy/engine'
import { buildHighlightedSegments } from '../policy/highlight'
import { newPolicyRule, type PolicyRule } from '../policy/rules'
import { PolicyHelp } from './PolicyHelp'

interface Props {
  rules: PolicyRule[]
  onRulesChange: (rules: PolicyRule[]) => void
  onClose: () => void
  hint: string
  notifyStatus: string
  onRequestNotifications: () => void
  onShare?: () => void
}

export function PolicyPanel({
  rules,
  onRulesChange,
  onClose,
  hint,
  notifyStatus,
  onRequestNotifications,
  onShare,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>(() => rules[0]?.id ?? '')
  const selected = useMemo(() => rules.find((r) => r.id === selectedId) ?? rules[0] ?? null, [rules, selectedId])
  const [draft, setDraft] = useState(selected?.source ?? '')
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [showHelp, setShowHelp] = useState(false)
  const highlightRef = useRef<HTMLPreElement | null>(null)

  // Reset the draft whenever a different rule is selected, when the
  // selected rule's source changes from outside (e.g. Save, or loading a
  // shared `?policy=` link), or on rule-list identity change.
  useEffect(() => {
    setDraft(selected?.source ?? '')
  }, [selectedId, selected?.source])

  useEffect(() => {
    let cancelled = false
    highlightPolicy(draft)
      .then((out) => {
        if (!cancelled) setTokens(out.tokens)
      })
      .catch(() => {
        if (!cancelled) setTokens([])
      })
    return () => {
      cancelled = true
    }
  }, [draft])

  const highlightedSegments = useMemo(() => buildHighlightedSegments(draft, tokens), [draft, tokens])
  const dirty = selected != null && draft !== selected.source

  function patchRule(id: string, patch: Partial<PolicyRule>) {
    onRulesChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRule() {
    const rule = newPolicyRule('')
    onRulesChange([...rules, rule])
    setSelectedId(rule.id)
  }

  function removeRule(id: string) {
    const next = rules.filter((r) => r.id !== id)
    onRulesChange(next)
    if (selectedId === id) setSelectedId(next[0]?.id ?? '')
  }

  function save() {
    if (!selected) return
    patchRule(selected.id, { source: draft })
  }

  return (
    <div className="modal-backdrop modal-backdrop-lower" onClick={onClose}>
      <div className="modal-card policy-panel-card" onClick={(e) => e.stopPropagation()}>
        <form
          className="card propose-form policy-home-panel"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div className="propose-head">
            <h2>Notification policy</h2>
            <div className="propose-head-actions">
              <button type="button" className="ghost danger" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>

          <p className="policy-demo-hint">
            {hint} {notifyStatus}
          </p>

          <div className="policy-actions-row">
            <button type="button" className="panel-button" onClick={onRequestNotifications}>
              Enable notifications
            </button>
            <button
              type="button"
              className="panel-button policy-emoji-button policy-icon-only"
              onClick={() => setShowHelp(true)}
              title="Help"
              aria-label="Help"
            >
              <span className="noto-emoji" aria-hidden="true">❓</span>
            </button>
            {onShare && (
              <button
                type="button"
                className="panel-button policy-emoji-button policy-icon-only"
                onClick={onShare}
                title="Share"
                aria-label="Share"
              >
                <span className="noto-emoji" aria-hidden="true">🔗</span>
              </button>
            )}
            <button
              type="button"
              className={`panel-button policy-emoji-button policy-icon-only ${dirty ? 'dirty' : ''}`}
              onClick={save}
              title="Save"
              aria-label="Save"
            >
              <span className="noto-emoji" aria-hidden="true">💾</span>
              {dirty && <span className="policy-dirty-star" aria-hidden="true">*</span>}
            </button>
          </div>

          <div className="policy-tabs" role="tablist" aria-label="Policy rules">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className={`policy-tab ${rule.id === selected?.id ? 'active' : ''} ${rule.enabled ? '' : 'disabled'}`}
              >
                <button
                  type="button"
                  className="policy-tab-title"
                  role="tab"
                  aria-selected={rule.id === selected?.id}
                  onClick={() => setSelectedId(rule.id)}
                >
                  Rule {rules.findIndex((r) => r.id === rule.id) + 1}
                </button>
                <button
                  type="button"
                  className="policy-tab-remove"
                  onClick={() => removeRule(rule.id)}
                  title="Remove rule"
                  aria-label="Remove rule"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="policy-tab-add"
              onClick={addRule}
              title="Add rule"
              aria-label="Add rule"
            >
              +
            </button>
          </div>

          <div className="policy-editor-shell">
            <pre ref={highlightRef} aria-hidden className="policy-highlight-layer">
              {highlightedSegments.map((seg, idx) => (
                <span key={idx} className={seg.kind ? `token-${seg.kind}` : undefined}>
                  {seg.text}
                </span>
              ))}
            </pre>
            <textarea
              className="policy-demo-input policy-overlay-input"
              value={draft}
              rows={4}
              spellCheck={false}
              disabled={!selected}
              onScroll={(e) => {
                if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
              }}
            />
          </div>

          <label className="check-row policy-enabled-row">
            <input
              type="checkbox"
              checked={selected?.enabled ?? false}
              disabled={!selected}
              onChange={(e) => {
                if (!selected) return
                patchRule(selected.id, { enabled: e.target.checked })
              }}
            />
            <span>Enabled</span>
          </label>
        </form>
      </div>
      {showHelp && <PolicyHelp onClose={() => setShowHelp(false)} />}
    </div>
  )
}
