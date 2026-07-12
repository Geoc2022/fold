import { useEffect, useRef, useState } from 'react'
import { searchEmoji } from '../emojiSearch'
import { PICTOGRAM_BY_EMOJI } from '../pictogramCatalog'
import { EmojiGlyph } from './EmojiGlyph'

interface Props {
  value: string
  onChange: (value: string) => void
  /** The in-progress activity title, used to rank icon suggestions. */
  title: string
}

const PICTOGRAM_EMOJI = Object.keys(PICTOGRAM_BY_EMOJI)
const TOP_MATCH_COUNT = 6

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

/** A small editable box (type or paste one emoji/symbol directly) that also
 * pops up a grid: top title matches, then pictograms, then everything else. */
export function EmojiPicker({ value, onChange, title }: Props) {
  const [open, setOpen] = useState(false)
  const [topMatches, setTopMatches] = useState<string[]>([])
  const [allEmoji, setAllEmoji] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    searchEmoji(title).then((ranked) => {
      if (cancelled) return
      const withoutPictograms = ranked.filter((em) => !(em in PICTOGRAM_BY_EMOJI))
      setTopMatches(withoutPictograms.slice(0, TOP_MATCH_COUNT))
      setAllEmoji(withoutPictograms.slice(TOP_MATCH_COUNT))
    })
    return () => {
      cancelled = true
    }
  }, [title])

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [])

  function pick(em: string) {
    onChange(em)
    setOpen(false)
  }

  function renderGrid(emoji: string[], scroll?: boolean) {
    return (
      <div className={`emoji-grid ${scroll ? 'emoji-grid-scroll' : ''}`}>
        {emoji.map((em) => (
          <button
            type="button"
            key={em}
            className={`emoji-pick ${value === em ? 'active' : ''}`}
            onClick={() => pick(em)}
          >
            <EmojiGlyph emoji={em} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="emoji-picker" ref={ref}>
      <input
        className="emoji-box"
        maxLength={8}
        value={value}
        aria-label="Emoji or symbol"
        onFocus={() => setOpen(true)}
        onChange={(e) => onChange(firstGrapheme(e.target.value))}
      />
      {open && (
        <div className="emoji-nav">
          {renderGrid(topMatches)}
          <div className="emoji-nav-divider" />
          {renderGrid(PICTOGRAM_EMOJI)}
          <div className="emoji-nav-divider" />
          {renderGrid(allEmoji, true)}
        </div>
      )}
    </div>
  )
}
