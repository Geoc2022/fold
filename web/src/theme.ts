// Shared light/dark theme (Nord palette) used across the whole app -- the
// homepage and the activity rooms both toggle the same `data-theme`
// attribute/storage key, via the ◐ / ◑ control.

import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'fold.theme'

function readStored(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore storage failures (private mode) */
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readStored)

  useEffect(() => {
    apply(theme)
  }, [theme])

  return {
    theme,
    toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
  }
}
