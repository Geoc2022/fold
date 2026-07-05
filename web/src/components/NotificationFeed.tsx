import { api } from '../api'
import { relativeTime } from '../format'
import type { Notification } from '../types'

interface Props {
  notifications: Notification[]
  now: number
  onRead: () => void
}

const KIND_ICON: Record<string, string> = {
  activity_proposed: '✨',
  activity_interest: '👀',
  activity_commit: '✓',
  activity_ready: '🎉',
  activity_scheduled: '🕒',
  activity_closed: '🔒',
  activity_cancelled: '✕',
}

export function NotificationFeed({ notifications, now, onRead }: Props) {
  const unread = notifications.length

  async function markAll() {
    try {
      await api.markRead()
      onRead()
    } catch {
      /* best-effort; next poll reconciles */
    }
  }

  return (
    <section className="feed card">
      <header className="feed-head">
        <h2>Activity {unread > 0 && <span className="pill">{unread}</span>}</h2>
        {unread > 0 && (
          <button className="ghost sm" onClick={markAll}>
            Mark all read
          </button>
        )}
      </header>
      {unread === 0 ? (
        <p className="empty">You're all caught up.</p>
      ) : (
        <ul className="feed-list">
          {notifications.map((n) => (
            <li key={n.id}>
              <span className="feed-icon">{KIND_ICON[n.kind] ?? '•'}</span>
              <span className="feed-msg">{n.message}</span>
              <span className="feed-time">{relativeTime(n.created_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
