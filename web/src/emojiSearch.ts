// The picker is a plain scroll through every emoji Noto Emoji supports.
// Keywords come from `emojilib` (MIT, github.com/muan/emojilib -- the
// dataset behind GitHub's own emoji picker) purely as a source of emoji
// characters to list; we don't do any keyword search/ranking. Shipped as a
// lazily-fetched static asset so it doesn't bloat the main bundle for
// people who never open the picker.

let cache: string[] | null = null
let inflight: Promise<string[]> | null = null

/** All emoji characters, in dataset order. */
export function loadAllEmoji(): Promise<string[]> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = fetch('/emoji-keywords.json')
    .then((r) => r.json())
    .then((data: Record<string, string[]>) => {
      const all = Object.keys(data)
      cache = all
      return all
    })
  return inflight
}
