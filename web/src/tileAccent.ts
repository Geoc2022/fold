// Each tile's accent color is a deterministic hash of the activity's title
// (not the emoji -- we don't inspect rendered glyph pixels anymore), picked
// from the Nord "aurora"/"frost" hues only. Nord0-6 are backgrounds/panels
// and are intentionally excluded so every tile gets an actual color.

import { hashUnit } from './hash'

const ACCENT_COLORS = [
  '#8FBCBB', // nord7
  '#88C0D0', // nord8
  '#81A1C1', // nord9
  '#5E81AC', // nord10
  '#BF616A', // nord11
  '#D08770', // nord12
  '#EBCB8B', // nord13
  '#A3BE8C', // nord14
  '#B48EAD', // nord15
]

export function tileAccentColor(title: string): string {
  const idx = Math.floor(hashUnit(title) * ACCENT_COLORS.length) % ACCENT_COLORS.length
  return ACCENT_COLORS[idx]
}
