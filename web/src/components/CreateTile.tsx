import type { HomeView } from './ViewToggle'

interface Props {
  view: HomeView
  onClick: () => void
}

/** The "+" tile/row that opens the propose-activity form. */
export function CreateTile({ view, onClick }: Props) {
  if (view === 'list') {
    return (
      <button type="button" className="list-item create-list-item" onClick={onClick}>
        <span className="list-emoji">➕</span>
        <div className="list-info">
          <h3>Propose an activity</h3>
        </div>
      </button>
    )
  }
  return (
    <button type="button" className="tile create-tile" onClick={onClick}>
      <span className="tile-emoji">➕</span>
      <span className="tile-title">Propose an activity</span>
    </button>
  )
}
