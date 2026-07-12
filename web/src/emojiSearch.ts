// Emoji-by-keyword search, backed by `emojilib` (MIT, github.com/muan/emojilib
// -- the dataset behind GitHub's own emoji picker). Rather than hand-roll a
// keyword list, we reuse that already-solved dataset: 1900+ emoji with
// curated keyword arrays. Shipped as a lazily-fetched static asset (like the
// pictogram SVGs) so it doesn't bloat the main bundle for people who never
// open the icon picker.

export type EmojiKeywords = Record<string, string[]>

let cache: EmojiKeywords | null = null
let inflight: Promise<EmojiKeywords> | null = null

function load(): Promise<EmojiKeywords> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = fetch('/emoji-keywords.json')
    .then((r) => r.json())
    .then((data: EmojiKeywords) => {
      cache = data
      return data
    })
  return inflight
}

/** Ranked emoji matching a free-text query (e.g. an in-progress activity
 * title). Resolves to the full dataset order when the query is empty. */
export async function searchEmoji(query: string, limit?: number): Promise<string[]> {
  const data = await load()
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  const entries = Object.entries(data)

  if (words.length === 0) {
    const all = entries.map(([emoji]) => emoji)
    return limit == null ? all : all.slice(0, limit)
  }

  const scored = entries
    .map(([emoji, keywords]) => {
      let score = 0
      for (const kw of keywords) {
        for (const w of words) {
          if (kw === w) score += 3
          else if (kw.startsWith(w) || w.startsWith(kw)) score += 2
          else if (kw.includes(w) || w.includes(kw)) score += 1
        }
      }
      return { emoji, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  const ranked = scored.map((s) => s.emoji)
  if (limit == null || ranked.length >= limit) {
    return limit == null ? ranked : ranked.slice(0, limit)
  }

  // Pad with dataset order so the grid never looks sparse for odd queries.
  const seen = new Set(ranked)
  for (const [emoji] of entries) {
    if (ranked.length >= limit) break
    if (!seen.has(emoji)) {
      ranked.push(emoji)
      seen.add(emoji)
    }
  }
  return ranked
}
