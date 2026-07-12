import { PICTOGRAM_BY_EMOJI } from '../pictogramCatalog'
import { PictogramIcon } from './PictogramIcon'

interface Props {
  emoji: string
  className?: string
}

/** Renders an activity's icon: an Olympic-style pictogram if we have art for
 * it, otherwise the monochrome Noto Emoji glyph. Both render in whatever
 * `color` the parent sets (currentColor) -- no per-icon color logic here. */
export function EmojiGlyph({ emoji, className }: Props) {
  const slug = PICTOGRAM_BY_EMOJI[emoji]
  if (slug) return <PictogramIcon slug={slug} className={className} />
  return <span className={`${className ?? ''} noto-emoji`}>{emoji}</span>
}
