import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadEmojiKeywords, searchEmoji } from '../emojiSearch'
import { useForceTheme } from '../useForceTheme'
import { EmojiGlyph } from '../components/EmojiGlyph'

interface EmojiEntry {
  emoji: string
  keywords: string[]
}

export function EmojiLabPage() {
  useForceTheme('light')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<EmojiEntry[]>([])
  const resultsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    loadEmojiKeywords().then((data) => {
      if (cancelled) return
      const all = Object.entries(data).map(([emoji, keywords]) => ({ emoji, keywords }))
      setEntries(all)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const results = useMemo(() => searchEmoji(query, entries, 160), [query, entries])

  return (
    <main className="emoji-lab-page">
      <section className="emoji-lab-card">
        <header className="emoji-lab-head">
          <h1>Emoji Lab</h1>
          <Link to="/" className="ghost sm">Back</Link>
        </header>
        <p className="emoji-lab-sub">Simple Noto Emoji search for quick picker experiments.</p>
        <input
          className="emoji-lab-input"
          placeholder="Search: smile, sports, animal, food..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          ref={resultsRef}
          className="emoji-lab-results"
          tabIndex={0}
          onKeyDown={(e) => {
            const el = resultsRef.current
            if (!el) return
            const row = 48
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              el.scrollBy({ top: row, behavior: 'smooth' })
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              el.scrollBy({ top: -row, behavior: 'smooth' })
            } else if (e.key === 'PageDown') {
              e.preventDefault()
              el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' })
            } else if (e.key === 'PageUp') {
              e.preventDefault()
              el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' })
            }
          }}
        >
          {results.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-lab-cell"
              title={emoji}
              onClick={() => navigator.clipboard?.writeText(emoji)}
            >
              <EmojiGlyph emoji={emoji} />
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}
