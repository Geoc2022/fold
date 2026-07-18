import { useMemo, useState } from 'react'

export function useScript<T extends string>(steps: T[], startAt = 0) {
  const [index, setIndex] = useState(startAt)
  const step = steps[Math.max(0, Math.min(steps.length - 1, index))]
  const isLast = index >= steps.length - 1

  return useMemo(
    () => ({
      step,
      index,
      isLast,
      next: () => setIndex((n) => Math.min(steps.length - 1, n + 1)),
      back: () => setIndex((n) => Math.max(0, n - 1)),
      set: (n: number) => setIndex(Math.max(0, Math.min(steps.length - 1, n))),
      reset: () => setIndex(startAt),
    }),
    [index, isLast, startAt, step, steps.length],
  )
}
