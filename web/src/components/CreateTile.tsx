import { motion } from 'framer-motion'
import type { HomeView } from './ViewToggle'

interface Props {
  view: HomeView
  onClick: () => void
}

/** The "+" tile/row that opens the propose-activity form. */
export function CreateTile({ view, onClick }: Props) {
  if (view === 'list') {
    return (
      <motion.button layout type="button" className="list-item create-list-item" onClick={onClick}>
        <span className="list-emoji create-plus">+</span>
      </motion.button>
    )
  }
  return (
    <motion.button
      layout
      type="button"
      className="tile create-tile"
      style={{ gridColumn: 'span 1', gridRow: 'span 1' }}
      onClick={onClick}
    >
      <span className="create-plus">+</span>
    </motion.button>
  )
}
