import { useEffect, useState } from 'react'
import { api } from '../api'

type PushState =
  | 'checking'
  | 'unsupported'
  | 'not-configured'
  | 'off'
  | 'on'
  | 'blocked'

function appServerKey(publicKey: string): ArrayBuffer {
  const padded = `${publicKey}${'='.repeat((4 - (publicKey.length % 4)) % 4)}`
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const buffer = new ArrayBuffer(raw.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return buffer
}

export function PushPanel() {
  const [state, setState] = useState<PushState>('checking')
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (!cancelled) setState('unsupported')
        return
      }
      const cfg = await api.pushPublicKey()
      if (cancelled) return
      if (!cfg.enabled || !cfg.public_key) {
        setState('not-configured')
        return
      }
      setPublicKey(cfg.public_key)
      if (Notification.permission === 'denied') {
        setState('blocked')
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js')
      const sub = await reg.pushManager.getSubscription()
      if (!cancelled) setState(sub ? 'on' : 'off')
    }
    check().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err))
        setState('off')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function enable() {
    if (!publicKey) return
    setBusy(true)
    setError(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'denied') {
        setState('blocked')
        return
      }
      if (permission !== 'granted') return
      const reg = await navigator.serviceWorker.register('/sw.js')
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey(publicKey),
      })
      await api.pushSubscribe(sub.toJSON())
      setState('on')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint)
        await sub.unsubscribe()
      }
      setState('off')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'checking') return null
  if (state === 'unsupported') {
    return <p className="hint push-note">This browser does not support Web Push.</p>
  }
  if (state === 'not-configured') {
    return <p className="hint push-note">Push is disabled until VAPID keys are configured.</p>
  }
  if (state === 'blocked') {
    return <p className="hint push-note">Push notifications are blocked in this browser.</p>
  }

  return (
    <div className="push-panel">
      <div>
        <strong>Push notifications</strong>
        <p className="hint">
          {state === 'on'
            ? 'Enabled on this device.'
            : 'Get a device notification when fold changes.'}
        </p>
      </div>
      <button className="ghost sm" disabled={busy} onClick={state === 'on' ? disable : enable}>
        {busy ? '…' : state === 'on' ? 'Disable' : 'Enable'}
      </button>
      {error && <p className="err small">{error}</p>}
    </div>
  )
}
