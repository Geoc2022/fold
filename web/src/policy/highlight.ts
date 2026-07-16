import type { HighlightToken } from './engine'

export interface HighlightSegment {
  text: string
  kind: string | null
}

/** Split `source` into highlighted segments given the tokens returned by
 * `highlightPolicy`. Shared by the policy editors (home panel, math page). */
export function buildHighlightedSegments(source: string, tokens: HighlightToken[]): HighlightSegment[] {
  const out: HighlightSegment[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) out.push({ text: source.slice(cursor, token.start), kind: null })
    out.push({ text: source.slice(token.start, token.end), kind: token.kind })
    cursor = token.end
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), kind: null })
  if (out.length === 0) out.push({ text: source || ' ', kind: null })
  return out
}
