let cache: string[] | null = null
let inflight: Promise<string[]> | null = null
let keywordCache: Record<string, string[]> | null = null
let keywordInflight: Promise<Record<string, string[]>> | null = null

// Noto Emoji (monochrome) coverage is limited; keep only the classic
// single-codepoint symbols from the documented supported blocks.
const NOTO_EMOJI_BLOCKS: Array<[number, number]> = [
  [0x1f300, 0x1f5ff], // Miscellaneous Symbols and Pictographs
  [0x1f600, 0x1f64f], // Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map Symbols
  [0x2600, 0x26ff], // Miscellaneous Symbols
  [0x1f100, 0x1f1ff], // Enclosed Alphanumeric Supplement
  [0x2700, 0x27bf], // Dingbats
  [0x1f200, 0x1f2ff], // Enclosed Ideographic Supplement
  [0x25a0, 0x25ff], // Geometric Shapes
  [0x2190, 0x21ff], // Arrows
  [0x2300, 0x23ff], // Miscellaneous Technical
  [0x2b00, 0x2bff], // Miscellaneous Symbols and Arrows
]

function inNotoEmojiBlocks(cp: number): boolean {
  return NOTO_EMOJI_BLOCKS.some(([start, end]) => cp >= start && cp <= end)
}

function isNotoMonochromeEmoji(emoji: string): boolean {
  if (!emoji) return false
  // Exclude known non-single-codepoint emoji sequences.
  if (emoji.includes('\u200d') || emoji.includes('\u20e3')) return false
  if (/\p{Regional_Indicator}/u.test(emoji)) return false
  if (/[\u{1F3FB}-\u{1F3FF}]/u.test(emoji)) return false
  if (/[\u{E0020}-\u{E007F}]/u.test(emoji)) return false

  const stripped = emoji.replace(/[\uFE0E\uFE0F]/g, '')
  const cps = Array.from(stripped)
  if (cps.length !== 1) return false
  const cp = cps[0].codePointAt(0)
  if (cp == null) return false
  return inNotoEmojiBlocks(cp)
}

/** All emoji characters, in dataset order. */
export function loadAllEmoji(): Promise<string[]> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = fetch('/emoji-keywords.json')
    .then((r) => r.json())
    .then((data: Record<string, string[]>) => {
      const all = Object.keys(data).filter(isNotoMonochromeEmoji)
      cache = all
      return all
    })
  return inflight
}

/** Noto-safe emoji -> searchable keyword list. */
export function loadEmojiKeywords(): Promise<Record<string, string[]>> {
  if (keywordCache) return Promise.resolve(keywordCache)
  if (keywordInflight) return keywordInflight
  keywordInflight = fetch('/emoji-keywords.json')
    .then((r) => r.json())
    .then((data: Record<string, string[]>) => {
      const filtered: Record<string, string[]> = {}
      for (const [emoji, keywords] of Object.entries(data)) {
        if (!isNotoMonochromeEmoji(emoji)) continue
        filtered[emoji] = keywords
      }
      keywordCache = filtered
      cache = Object.keys(filtered)
      return filtered
    })
  return keywordInflight
}

export function searchEmoji(
  query: string,
  entries: Array<{ emoji: string; keywords: string[] }>,
  limit = 120,
): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries.slice(0, limit).map((e) => e.emoji)
  const ranked = entries
    .map((entry, index) => {
      if (entry.emoji === q) return { emoji: entry.emoji, score: 1000 + (entries.length - index) * 0.00001 }
      let score = 0
      for (const raw of entry.keywords) {
        const kw = raw.toLowerCase()
        if (kw === q) score += 200
        else if (kw.startsWith(q)) score += 80
        else if (kw.includes(q)) score += 35
      }
      return { emoji: entry.emoji, score: score + (entries.length - index) * 0.00001 }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.emoji)
  return ranked
}
