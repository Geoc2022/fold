// Stable string hash (FNV-1a), normalized to [0, 1). Shared by anything that
// needs a "random but consistent across every user" value derived from a
// name/id -- tile popularity jitter, emoji fallback colors, etc.
export function hashUnit(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967295
}
