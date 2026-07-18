import { useLayoutEffect, useState } from 'react'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export function Spotlight({ target }: { target: string }) {
  const [rect, setRect] = useState<Rect | null>(null)

  useLayoutEffect(() => {
    const element = document.querySelector(target)
    const update = () => {
      if (!element) {
        setRect(null)
        return
      }
      const next = element.getBoundingClientRect()
      const pad = 8
      setRect({
        top: next.top - pad,
        left: next.left - pad,
        width: next.width + pad * 2,
        height: next.height + pad * 2,
      })
    }
    update()
    const observer = element ? new ResizeObserver(update) : null
    if (element) observer?.observe(element)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [target])

  if (!rect) return null
  return <div className="tutorial-spotlight" style={rect} aria-hidden="true" />
}
