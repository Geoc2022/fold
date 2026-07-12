import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
}

const SUGGESTIONS = ['🎲', '🏸', '⚽️', '🎮', '☕️', '🧩', '🃏', '🍜', '📖', '🎵', '🏓', '🎯']

/** A small editable box (type or paste any emoji/unicode symbol directly)
 * that also pops up a quick-pick nav of suggestions on focus. */
export function EmojiPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [])

  return (
    <div className="emoji-picker" ref={ref}>
      <input
        className="emoji-box"
        maxLength={8}
        value={value}
        aria-label="Emoji or symbol"
        onFocus={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <div className="emoji-nav">
          {SUGGESTIONS.map((em) => (
            <button
              type="button"
              key={em}
              className={`emoji-pick ${value === em ? 'active' : ''}`}
              onClick={() => {
                onChange(em)
                setOpen(false)
              }}
            >
              {em}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
