interface Props {
  emoji: string
  className?: string
}

function forceMonochromePresentation(emoji: string): string {
  if (!emoji) return emoji
  const VS15 = '\uFE0E'
  const VS16 = '\uFE0F'
  const KEYCAP = '\u20E3'

  // Normalize explicit emoji-presentation selectors to text presentation to
  // avoid platform color-emoji fallback for symbols like ☝️/✍️/🕵️.
  // Keep keycap sequences intact (e.g. 1️⃣) because changing their selector
  // can break the grapheme.
  let out = ''
  for (let i = 0; i < emoji.length; i += 1) {
    const ch = emoji[i]
    if (ch === VS16) {
      const next = emoji[i + 1] ?? ''
      out += next === KEYCAP ? VS16 : VS15
      continue
    }
    out += ch
  }
  return out
}

/** Renders an activity's icon as a Noto Emoji glyph (monochrome, colored via
 * `currentColor` by whatever the parent sets). */
export function EmojiGlyph({ emoji, className }: Props) {
  return <span className={`${className ?? ''} noto-emoji`}>{forceMonochromePresentation(emoji)}</span>
}
