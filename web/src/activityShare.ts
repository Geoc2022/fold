import type { ActivityView, ParticipantView } from './types'

const STATE_GLYPHS = {
  arrived: '🔴',
  committed: '🟠',
  interested: '🟢',
  empty: '⚪',
} as const

export function buildActivityShareText(
  activity: ActivityView,
  participants: ParticipantView[],
  now: number,
  url: string,
): string {
  const glyphs: string[] = participants
    .map((participant) => {
      if (participant.state === 'interested') return STATE_GLYPHS.interested
      if (participant.arrival_at != null && participant.arrival_at <= now) return STATE_GLYPHS.arrived
      return STATE_GLYPHS.committed
    })
    .sort((a, b) => glyphOrder(a) - glyphOrder(b))

  const rowSize = activity.grouping_mode === 'tiling'
    ? Math.max(1, activity.group_multiple)
    : Math.max(activity.min_people, glyphs.length)
  const slotCount = activity.grouping_mode === 'tiling'
    ? Math.max(rowSize, Math.ceil(activity.min_people / rowSize) * rowSize, Math.ceil(glyphs.length / rowSize) * rowSize)
    : rowSize
  while (glyphs.length < slotCount) glyphs.push(STATE_GLYPHS.empty)

  const rows: string[] = []
  for (let i = 0; i < glyphs.length; i += rowSize) rows.push(glyphs.slice(i, i + rowSize).join(''))
  return [`${activity.emoji} ${activity.title} — /${activity.code}`, ...rows, url].join('\n')
}

function glyphOrder(glyph: string) {
  const order: readonly string[] = [STATE_GLYPHS.arrived, STATE_GLYPHS.committed, STATE_GLYPHS.interested, STATE_GLYPHS.empty]
  return order.indexOf(glyph)
}
