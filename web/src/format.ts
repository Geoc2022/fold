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

export function shortDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return new Date(ms).toISOString()
  }
}

/** Convert a <input type="datetime-local"> value to epoch ms, or null. */
export function localInputToMs(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}
