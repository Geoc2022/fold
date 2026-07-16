import { useEffect, useRef, useState } from 'react'
import { loadEmojiKeywords, searchEmoji } from '../emojiSearch'
import { EmojiGlyph } from './EmojiGlyph'

interface Props {
  value: string
  onChange: (value: string) => void
  searchText?: string
}

/** Exactly one grapheme cluster -- a user's idea of "one character", even
 * for multi-codepoint emoji sequences (flags, ZWJ sequences, etc). */
function firstGrapheme(s: string): string {
  if (!s) return s
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const first = segmenter.segment(s)[Symbol.iterator]().next()
    return first.done ? '' : first.value.segment
  }
  return Array.from(s)[0] ?? ''
}

/** A small editable box (type or paste one emoji directly) that also pops
 * up a simple scrollable grid of every Noto Emoji to pick from. */
export function EmojiPicker({ value, onChange, searchText = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Array<{ emoji: string; keywords: string[] }>>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadEmojiKeywords().then((data) => {
      const all = Object.entries(data).map(([emoji, keywords]) => ({ emoji, keywords }))
      setEntries(all)
    })
  }, [])

  const results = searchEmoji(searchText, entries, 160)

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
        aria-label="Emoji"
        onFocus={() => setOpen(true)}
        onChange={(e) => onChange(firstGrapheme(e.target.value))}
      />
      {open && (
        <div className="emoji-nav">
          <div className="emoji-grid">
            {results.map((em) => (
              <button
                type="button"
                key={em}
                className={`emoji-pick ${value === em ? 'active' : ''}`}
                onClick={() => {
                  onChange(em)
                  void navigator.clipboard?.writeText(em)
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
