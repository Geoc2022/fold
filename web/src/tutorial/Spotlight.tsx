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
    let observed: Element | null = null
    const resizeObserver = new ResizeObserver(() => update())
    const update = () => {
      const element = document.querySelector(target)
      if (element !== observed) {
        if (observed) resizeObserver.unobserve(observed)
        observed = element
        if (observed) resizeObserver.observe(observed)
      }
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
    const mutationObserver = new MutationObserver(update)
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [target])

  if (!rect) return null
  return <div className="tutorial-spotlight" style={rect} aria-hidden="true" />
}
