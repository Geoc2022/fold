import { useEffect, useMemo, useRef, useState } from 'react'
import { searchEmoji } from '../emojiCatalog'
import { EmojiGlyph } from './EmojiGlyph'

interface Props {
  value: string
  onChange: (value: string) => void
  /** The in-progress activity title, used to rank icon suggestions. */
  title: string
}

/** A small editable box (type or paste any emoji/unicode symbol directly)
 * that also pops up a grid of icons best-matching the activity title. */
export function EmojiPicker({ value, onChange, title }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const candidates = useMemo(() => searchEmoji(title), [title])

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
          <p className="emoji-nav-hint">
            {title.trim() ? `Best matches for "${title.trim()}"` : 'Type a title for better matches'}
          </p>
          <div className="emoji-grid">
            {candidates.map((em) => (
              <button
                type="button"
                key={em}
                className={`emoji-pick ${value === em ? 'active' : ''}`}
                onClick={() => {
                  onChange(em)
                  setOpen(false)
                }}
              >
                <EmojiGlyph emoji={em} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
