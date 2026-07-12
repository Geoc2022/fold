// Global preference for how activity emoji/symbols render: the browser's
// native color emoji, Google's monochrome Noto Emoji, or (for sports we have
// art for) a public-domain Olympic-style pictogram -- all tinted with the
// same per-emoji Nord accent color. Persisted like the theme, but shared via
// context so every tile/list-item on the page updates together when it's
// toggled (many independent instances of a localStorage-backed `useState`
// would each be stuck with whatever they read on mount).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type IconStyle = 'color' | 'noto' | 'pictogram'

const STYLES: IconStyle[] = ['color', 'noto', 'pictogram']
const KEY = 'fold.icon_style'

function readStored(): IconStyle {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'noto' || v === 'pictogram' ? v : 'color'
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
      toggleIconStyle: () =>
        setIconStyle((s) => STYLES[(STYLES.indexOf(s) + 1) % STYLES.length]),
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
