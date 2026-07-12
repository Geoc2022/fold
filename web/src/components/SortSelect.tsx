export type SortKey = 'newest' | 'oldest' | 'runs' | 'served' | 'commit' | 'name'

interface Props {
  value: SortKey
  onChange: (value: SortKey) => void
}

/** List-view-only "Sort by:" control, mirroring stackexchange.com/sites?view=list. */
export function SortSelect({ value, onChange }: Props) {
  return (
    <label className="sort-select">
      Sort by:
      <select value={value} onChange={(e) => onChange(e.target.value as SortKey)}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="runs">Runs</option>
        <option value="served">Served</option>
        <option value="commit">Commit %</option>
        <option value="name">Name</option>
      </select>
    </label>
  )
}
