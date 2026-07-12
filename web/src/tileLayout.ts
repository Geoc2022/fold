// Popularity-driven grid layout, mirroring stackexchange.com/sites: bigger,
// more-served activities get bigger tiles and float toward the top, but a
// deterministic hash-based jitter (seeded by the activity's own name/id, not
// per-user) lets smaller activities occasionally surface near the top too --
// consistently, for every visitor.

import { hashUnit } from './hash'
import type { ActivityView } from './types'

export type TileSize = 1 | 2 | 3

function popularity(a: ActivityView): number {
  return a.players_served * 2 + a.times_run
}

/** Grid-view default order: popularity first, with consistent per-tile jitter. */
export function popularityOrder(list: ActivityView[]): ActivityView[] {
  const maxPop = Math.max(1, ...list.map(popularity))
  return [...list]
    .map((a) => ({ a, score: popularity(a) + hashUnit(a.title + a.id) * maxPop * 0.6 }))
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a)
}

/** 1x1 / 2x2 / 3x3 unit size per activity, ranked by raw popularity (not the
 * jittered display order, so a "lucky" small activity doesn't look huge). */
export function tileSizes(list: ActivityView[]): Map<string, TileSize> {
  const byPopularity = [...list].sort((x, y) => popularity(y) - popularity(x))
  const n = byPopularity.length
  const sizes = new Map<string, TileSize>()
  byPopularity.forEach((a, i) => {
    const rank = n <= 1 ? 0 : i / (n - 1)
    sizes.set(a.id, rank < 0.12 ? 3 : rank < 0.4 ? 2 : 1)
  })
  return sizes
}
