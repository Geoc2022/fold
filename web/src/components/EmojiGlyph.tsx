import { useMemo } from 'react'
import { nordColorForEmoji } from '../emojiColor'
import { useIconStyle } from '../iconStyle'

interface Props {
  emoji: string
  className?: string
}

/** Renders an activity's emoji/symbol in whichever icon style is currently
 * selected: the browser's native color glyph, or monochrome Noto Emoji
 * tinted with the same per-emoji Nord accent either way. */
export function EmojiGlyph({ emoji, className }: Props) {
  const { iconStyle } = useIconStyle()
  const accent = useMemo(() => nordColorForEmoji(emoji), [emoji])

  if (iconStyle === 'noto') {
    return (
      <span className={`${className ?? ''} noto-emoji`} style={{ color: accent }}>
        {emoji}
      </span>
    )
  }
  return <span className={className}>{emoji}</span>
}
