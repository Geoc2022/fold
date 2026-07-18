import { forceMonochromePresentation } from '../emoji'

interface Props {
  emoji: string
  className?: string
}

/** Renders an activity's icon as a Noto Emoji glyph (monochrome, colored via
 * `currentColor` by whatever the parent sets). */
export function EmojiGlyph({ emoji, className }: Props) {
  return <span className={`${className ?? ''} noto-emoji`}>{forceMonochromePresentation(emoji)}</span>
}
