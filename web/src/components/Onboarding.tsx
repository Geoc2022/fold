import { useState } from 'react'
import { api, setPersonId } from '../api'
import type { Person } from '../types'

interface Props {
  onReady: (person: Person) => void
}

export function Onboarding({ onReady }: Props) {
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = handle.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const person = await api.createSession(trimmed)
      setPersonId(person.id)
      onReady(person)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="shell onboarding">
      <h1>fold</h1>
      <p className="tagline">spontaneous activities, coalesced</p>
      <form className="card onboard-card" onSubmit={submit}>
        <label htmlFor="handle">What should people call you?</label>
        <input
          id="handle"
          autoFocus
          maxLength={40}
          placeholder="e.g. Sam"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <button type="submit" disabled={busy || !handle.trim()}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        {error && <p className="err">{error}</p>}
        <p className="hint">
          No password. A local id is stored on this device so you can pick up
          where you left off.
        </p>
      </form>
    </main>
  )
}
