import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightPolicy, policyDocs, type HighlightToken } from '../policy/engine'
import { buildHighlightedSegments } from '../policy/highlight'
import { newPolicyRule, type PolicyRule } from '../policy/rules'

interface Props {
  rules: PolicyRule[]
  onRulesChange: (rules: PolicyRule[]) => void
  onClose: () => void
  notifyStatus: string
  onRequestNotifications: () => void
  onShare: () => void
}

export function PolicyPanel({ rules, onRulesChange, onClose, notifyStatus, onRequestNotifications, onShare }: Props) {
  const [selectedId, setSelectedId] = useState<string>(() => rules[0]?.id ?? '')
  const selected = useMemo(() => rules.find((r) => r.id === selectedId) ?? rules[0] ?? null, [rules, selectedId])
  const [draft, setDraft] = useState(selected?.source ?? '')
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [showHelp, setShowHelp] = useState(false)
  const [helpText, setHelpText] = useState('Loading documentation…')
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

  useEffect(() => {
    let cancelled = false
    void policyDocs().then((text) => {
      if (!cancelled) setHelpText(text)
    })
    return () => {
      cancelled = true
    }
  }, [])

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card policy-panel-card" onClick={(e) => e.stopPropagation()}>
        <section className="policy-home-panel">
          <div className="bio-section-title">Notification policy</div>
          <p className="policy-demo-hint">
            Rules run against activities you've joined. {notifyStatus}
          </p>

          <div className="policy-demo-row">
            <button type="button" className="panel-button" onClick={onRequestNotifications}>
              Enable notifications
            </button>
          </div>

          <div className="policy-rule-list">
            {rules.map((rule) => (
              <div key={rule.id} className={`policy-rule-item ${rule.id === selected?.id ? 'active' : ''}`}>
                <button type="button" className="policy-rule-select" onClick={() => setSelectedId(rule.id)}>
                  {shortId(rule.id)}
                </button>
                <label className="policy-rule-enabled">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
                  />
                  on
                </label>
                <button type="button" className="panel-button" onClick={() => removeRule(rule.id)}>
                  remove
                </button>
              </div>
            ))}
          </div>

          <div className="policy-demo-row">
            <button type="button" className="panel-button" onClick={addRule}>
              add rule
            </button>
            <button type="button" className="panel-button" onClick={save} disabled={!dirty}>
              {dirty ? 'save*' : 'save'}
            </button>
            <button type="button" className="panel-button" onClick={onShare}>
              share
            </button>
            <button type="button" className="panel-button" onClick={() => setShowHelp(true)}>
              help
            </button>
            <button type="button" className="panel-button" onClick={onClose}>
              close
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
              onScroll={(e) => {
                if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
              }}
            />
          </div>
        </section>
      </div>
      {showHelp && (
        <div
          className="math-help-backdrop"
          onClick={(e) => {
            e.stopPropagation()
            setShowHelp(false)
          }}
        >
          <section className="math-help-panel" onClick={(e) => e.stopPropagation()}>
            <header className="math-help-head">
              <h2>Policy Language</h2>
              <button type="button" onClick={() => setShowHelp(false)} title="Close help" aria-label="Close help">
                <span className="noto-emoji" aria-hidden="true">✖️</span>
              </button>
            </header>
            <pre className="math-help-markdown">{helpText}</pre>
          </section>
        </div>
      )}
    </div>
  )
}

function shortId(id: string) {
  return id.slice(0, 4)
}
