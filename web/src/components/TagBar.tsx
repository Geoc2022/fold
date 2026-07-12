import { titleCase } from '../format'

interface Props {
  /** Unique, lowercase categories present in the current activity list. */
  categories: string[]
  active: string
  onSelect: (category: string) => void
}

/** Horizontally-scrollable tag filter bar, e.g. "All", "Board Games". */
export function TagBar({ categories, active, onSelect }: Props) {
  return (
    <div className="tag-bar">
      <button className={`tag-pill ${active === 'all' ? 'active' : ''}`} onClick={() => onSelect('all')}>
        All
      </button>
      {categories.map((c) => (
        <button key={c} className={`tag-pill ${active === c ? 'active' : ''}`} onClick={() => onSelect(c)}>
          {titleCase(c)}
        </button>
      ))}
    </div>
  )
}
