interface Props {
  emoji: string
  className?: string
}

function forceMonochromePresentation(emoji: string): string {
  if (!emoji) return emoji
  const base = emoji.replace(/\uFE0E|\uFE0F/g, '')
  // These symbols often render as color emoji with VS16 on Apple fallback;
  // force text presentation to keep the monochrome Noto look.
  if (new Set(['☺', '☹', '❤', '❣', '✌', '🖐']).has(base)) {
    return `${base}\uFE0E`
  }
  return emoji
}

/** Renders an activity's icon as a Noto Emoji glyph (monochrome, colored via
 * `currentColor` by whatever the parent sets). */
export function EmojiGlyph({ emoji, className }: Props) {
  return <span className={`${className ?? ''} noto-emoji`}>{forceMonochromePresentation(emoji)}</span>
}
