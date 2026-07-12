// Maps emoji already in EMOJI_CATALOG to a downloaded Olympic-style sport
// pictogram (public domain / CC0, from Wikimedia Commons's
// Category:Olympic_pictograms -- unofficial fan-made pictograms, not the
// IOC's official marks). Served as plain static assets from /pictograms/.
// Only covers the sports we have art for; everything else falls back to the
// emoji/Noto rendering.
export const PICTOGRAM_BY_EMOJI: Record<string, string> = {
  '🏸': 'badminton',
  '🏀': 'basketball',
  '⚽': 'soccer',
  '🏈': 'american_football',
  '⚾': 'baseball',
  '🎾': 'tennis',
  '🏐': 'volleyball',
  '🏓': 'table_tennis',
  '🏒': 'hockey',
  '⛳': 'golf',
  '🥊': 'boxing',
  '🏊': 'swimming',
  '🚴': 'cycling',
  '🏃': 'running',
  '🧗': 'climbing',
  '⛷️': 'skiing',
  '🏂': 'snowboarding',
  '🥋': 'martial_arts',
  '🏹': 'archery',
  '🎳': 'bowling',
  '🛹': 'skateboarding',
  '🏄': 'surfing',
  '🚣': 'rowing',
  '🏇': 'horse',
  '🤺': 'fencing',
  '🥌': 'curling',
  '♟️': 'chess',
  '🏋️': 'weightlifting',
}
