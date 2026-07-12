// Global preference for how activity emoji/symbols render: the browser's
// native color emoji, or Google's monochrome Noto Emoji (tinted via the
// same per-emoji Nord accent color). Persisted like the theme, but shared
// via context so every tile/list-item on the page updates together when
// it's toggled (many independent instances of a localStorage-backed
// `useState` would each be stuck with whatever they read on mount).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type IconStyle = 'color' | 'noto'

const KEY = 'fold.icon_style'

function readStored(): IconStyle {
  try {
    return localStorage.getItem(KEY) === 'noto' ? 'noto' : 'color'
  } catch {
    return 'color'
  }
}

interface IconStyleContextValue {
  iconStyle: IconStyle
  toggleIconStyle: () => void
}

const IconStyleContext = createContext<IconStyleContextValue | null>(null)

export function IconStyleProvider({ children }: { children: ReactNode }) {
  const [iconStyle, setIconStyle] = useState<IconStyle>(readStored)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, iconStyle)
    } catch {
      /* ignore storage failures (private mode) */
    }
  }, [iconStyle])

  const value = useMemo(
    () => ({
      iconStyle,
      toggleIconStyle: () => setIconStyle((s) => (s === 'color' ? 'noto' : 'color')),
    }),
    [iconStyle],
  )

  return <IconStyleContext.Provider value={value}>{children}</IconStyleContext.Provider>
}

export function useIconStyle(): IconStyleContextValue {
  const ctx = useContext(IconStyleContext)
  if (!ctx) throw new Error('useIconStyle must be used within an IconStyleProvider')
  return ctx
}
