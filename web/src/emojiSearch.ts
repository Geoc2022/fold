let cache: string[] | null = null
let inflight: Promise<string[]> | null = null

function isNotoSingleGlyph(emoji: string): boolean {
  return !/\u200d/u.test(emoji) &&
    !/\p{Regional_Indicator}/u.test(emoji) &&
    !/[\u{1F3FB}-\u{1F3FF}]/u.test(emoji) &&
    !/[\u{E0020}-\u{E007F}]/u.test(emoji) &&
    !/\u20e3/u.test(emoji)
}

/** All emoji characters, in dataset order. */
export function loadAllEmoji(): Promise<string[]> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = fetch('/emoji-keywords.json')
    .then((r) => r.json())
    .then((data: Record<string, string[]>) => {
      const all = Object.keys(data).filter(isNotoSingleGlyph)
      cache = all
      return all
    })
  return inflight
}
