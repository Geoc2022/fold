export type HomeView = 'grid' | 'list'

interface Props {
  view: HomeView
  onChange: (view: HomeView) => void
}

/** Grid/list switch, mirroring stackexchange.com/sites?view=list. */
export function ViewToggle({ view, onChange }: Props) {
  return (
    <div className="view-toggle" role="group" aria-label="Layout">
      <button
        type="button"
        className={view === 'grid' ? 'active' : ''}
        aria-pressed={view === 'grid'}
        title="Grid view"
        onClick={() => onChange('grid')}
      >
        <GridIcon />
      </button>
      <button
        type="button"
        className={view === 'list' ? 'active' : ''}
        aria-pressed={view === 'list'}
        title="List view"
        onClick={() => onChange('list')}
      >
        <ListIcon />
      </button>
    </div>
  )
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="3" rx="1" fill="currentColor" />
      <rect x="3" y="10.5" width="18" height="3" rx="1" fill="currentColor" />
      <rect x="3" y="16.5" width="18" height="3" rx="1" fill="currentColor" />
    </svg>
  )
}
