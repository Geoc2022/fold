import { hashUnit } from './hash'

const ACCENT_COLORS = [
  '#00287F',
  '#0049AA',
  '#0078D0',
  '#005A46',
  '#00804D',
  '#00A651',
  '#980F30',
  '#BF192B',
  '#F0282D',
  '#E67324',
  '#FA841E',
]

export function tileAccentColor(title: string): string {
  const idx = Math.floor(hashUnit(title) * ACCENT_COLORS.length) % ACCENT_COLORS.length
  return ACCENT_COLORS[idx]
}
