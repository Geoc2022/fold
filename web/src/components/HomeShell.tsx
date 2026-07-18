import type { ReactNode } from 'react'
import { SortSelect, type SortKey } from './SortSelect'
import { TagBar } from './TagBar'
import { ViewToggle, type HomeView } from './ViewToggle'

interface Props {
  handleSlot: ReactNode
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  onOpenPolicy: () => void
  onRefresh: () => void
  onHelp: () => void
  error?: string | null
  toast?: string | null
  categories: string[]
  activeTag: string
  onTagSelect: (tag: string) => void
  view: HomeView
  sort: SortKey
  onSortChange: (sort: SortKey) => void
  onViewChange: (view: HomeView) => void
  children: ReactNode
}

export function HomeShell({
  handleSlot,
  theme,
  onThemeToggle,
  onOpenPolicy,
  onRefresh,
  onHelp,
  error,
  toast,
  categories,
  activeTag,
  onTagSelect,
  view,
  sort,
  onSortChange,
  onViewChange,
  children,
}: Props) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Fold</h1>
        </div>
        <div className="me">
          {handleSlot}
          <button className="icon-btn" onClick={onThemeToggle} title="Toggle theme">
            {theme === 'light' ? '◐' : '◑'}
          </button>
          <button
            className="icon-btn noto-emoji"
            onClick={onOpenPolicy}
            title="Notification policy"
            aria-label="Notification policy"
          >
            🔔
          </button>
          <button className="icon-btn" onClick={onHelp} title="Help" aria-label="Help">
            ?
          </button>
          <button className="icon-btn" onClick={onRefresh} title="Refresh">
            ↻
          </button>
        </div>
      </header>

      <main className="layout">
        {error && <p className="err small">Sync issue: {error}</p>}
        {toast && <div className="home-toast">{toast}</div>}

        <div className="browser-controls">
          <TagBar categories={categories} active={activeTag} onSelect={onTagSelect} />
          <div className="browser-controls-right">
            {view === 'list' && <SortSelect value={sort} onChange={onSortChange} />}
            <ViewToggle view={view} onChange={onViewChange} />
          </div>
        </div>

        {children}
      </main>
    </div>
  )
}
