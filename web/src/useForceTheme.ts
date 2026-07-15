import { useEffect } from 'react'

export function useForceTheme(theme: 'light' | 'dark') {
  useEffect(() => {
    const root = document.documentElement
    const prev = root.getAttribute('data-theme')
    root.setAttribute('data-theme', theme)
    return () => {
      if (prev == null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', prev)
    }
  }, [theme])
}
