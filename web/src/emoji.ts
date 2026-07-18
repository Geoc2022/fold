export function forceMonochromePresentation(emoji: string): string {
  if (!emoji) return emoji
  const VS15 = '\uFE0E'
  const VS16 = '\uFE0F'
  const KEYCAP = '\u20E3'

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
