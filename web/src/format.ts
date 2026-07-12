// Small formatting helpers shared across components.

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = ms - now
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)

  let value: number
  let unit: Intl.RelativeTimeFormatUnit
  if (sec < 60) {
    value = sec
    unit = 'second'
  } else if (min < 60) {
    value = min
    unit = 'minute'
  } else if (hr < 24) {
    value = hr
    unit = 'hour'
  } else {
    value = day
    unit = 'day'
  }

  const sign = diff < 0 ? -1 : 1
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    return rtf.format(sign * value, unit)
  } catch {
    return `${value}${unit[0]} ${diff < 0 ? 'ago' : 'from now'}`
  }
}

/** Convert a <input type="datetime-local"> value to epoch ms, or null. */
export function localInputToMs(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Stack-Exchange-style compact stat number: 24m, 3.1k, 942. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return trimZero(n / 1_000_000) + 'm'
  if (abs >= 1_000) return trimZero(n / 1_000) + 'k'
  return String(n)
}

function trimZero(n: number): string {
  const rounded = Math.round(n * 10) / 10
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)
}

/** commit_pct (0..1) -> "70%", or "—" when there's no data yet. */
export function formatPct(pct: number | null): string {
  if (pct == null) return '—'
  return `${Math.round(pct * 100)}%`
}

/** "board games" -> "Board Games". */
export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1))
}
