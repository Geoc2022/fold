import type { ReactNode } from 'react'

interface Props {
  title: string
  body: ReactNode
  onNext?: () => void
  onBack?: () => void
  nextLabel?: string
  showBack?: boolean
}

export function Coachmark({ title, body, onNext, onBack, nextLabel = 'Next', showBack = false }: Props) {
  return (
    <div className="tutorial-coachmark">
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="tutorial-actions">
        {showBack && (
          <button type="button" className="ghost" onClick={onBack}>
            Back
          </button>
        )}
        {onNext && (
          <button type="button" onClick={onNext}>
            {nextLabel}
          </button>
        )}
      </div>
    </div>
  )
}
