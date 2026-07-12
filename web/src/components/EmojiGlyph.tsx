import { useMemo } from 'react'
import { nordColorForEmoji } from '../emojiColor'
import { useIconStyle } from '../iconStyle'
import { PICTOGRAM_BY_EMOJI } from '../pictogramCatalog'
import { PictogramIcon } from './PictogramIcon'

interface Props {
  emoji: string
  className?: string
}

/** Renders an activity's emoji/symbol in whichever icon style is currently
 * selected: the browser's native color glyph, monochrome Noto Emoji, or (if
 * we have art for it) an Olympic-style pictogram -- all tinted with the
 * same per-emoji Nord accent color either way. */
export function EmojiGlyph({ emoji, className }: Props) {
  const { iconStyle } = useIconStyle()
  const accent = useMemo(() => nordColorForEmoji(emoji), [emoji])

  if (iconStyle === 'pictogram') {
    const slug = PICTOGRAM_BY_EMOJI[emoji]
    if (slug) return <PictogramIcon slug={slug} color={accent} className={className} />
    // No pictogram art for this one yet -- fall back to the plain glyph.
    return <span className={className}>{emoji}</span>
  }

  if (iconStyle === 'noto') {
    return (
      <span className={`${className ?? ''} noto-emoji`} style={{ color: accent }}>
        {emoji}
      </span>
    )
  }
  return <span className={className}>{emoji}</span>
}
