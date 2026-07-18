import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { RoomCanvas } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'
import { useTheme } from '../theme'
import type { ParticipantView } from '../types'
import { Coachmark } from '../tutorial/Coachmark'
import { advanceFakeCrowd, buildFakeCrowd, crowdAsParticipants } from '../tutorial/fakeCrowd'
import { foldTutorialActivity, tutorialMe } from '../tutorial/fakeRoom'
import { PartyBurst } from '../tutorial/PartyBurst'
import { useScript } from '../tutorial/useScript'

type SelfState = { state: 'lurker' | 'interested' | 'committed'; arrivalAt: number | null }

const SCRIPT = ['intro', 'move', 'commit', 'ready'] as const

export function RoomTutorial() {
  const me = useMemo(() => tutorialMe(), [])
  const { theme, toggleTheme } = useTheme()
  const [self, setSelf] = useState<SelfState>({ state: 'lurker', arrivalAt: null })
  const [crowdStarted, setCrowdStarted] = useState(false)
  const [partyActive, setPartyActive] = useState(false)
  const crowdRef = useRef(buildFakeCrowd(4))
  const [crowdTick, setCrowdTick] = useState(0)
  const script = useScript([...SCRIPT])

  useEffect(() => {
    if (!crowdStarted) return
    let stopped = false
    let last = performance.now()
    const timer = window.setInterval(() => {
      if (stopped) return
      const nowPerf = performance.now()
      const dtSec = Math.max(0.1, (nowPerf - last) / 1000)
      last = nowPerf
      advanceFakeCrowd(crowdRef.current, Date.now(), dtSec)
      setCrowdTick((n) => n + 1)
    }, 380)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [crowdStarted])

  const participants = useMemo<ParticipantView[]>(() => {
    const now = Date.now()
    const out = crowdAsParticipants(crowdRef.current, now)
    if (self.state !== 'lurker') {
      out.unshift({
        id: 'tutorial-self',
        color: me.color,
        state: self.state === 'committed' ? 'committed' : 'interested',
        arrival_at: self.state === 'committed' ? self.arrivalAt : null,
        is_me: true,
        last_seen_at: now,
      })
    }
    return out
  }, [crowdTick, me.color, self])

  const activity = useMemo(() => foldTutorialActivity(Date.now(), participants), [participants])
  const groupReady = Boolean(activity.current_run?.group.is_ready)

  useEffect(() => {
    if (groupReady) {
      setPartyActive(true)
      script.set(3)
    }
  }, [groupReady, script])

  async function onInterested() {
    setSelf({ state: 'interested', arrivalAt: null })
    if (!crowdStarted) {
      setCrowdStarted(true)
      script.set(2)
    }
  }

  async function onCommit(etaSeconds: number) {
    setSelf({ state: 'committed', arrivalAt: Date.now() + etaSeconds * 1000 })
    script.set(2)
  }

  async function onWithdraw() {
    setSelf({ state: 'lurker', arrivalAt: null })
  }

  const coach = (() => {
    if (script.step === 'intro') {
      return {
        title: 'Welcome to /FOLD',
        body: 'Drag your node inward to become interested. As soon as you do, four faux users start moving toward arrival.',
      }
    }
    if (script.step === 'move') {
      return {
        title: 'Move Your Node',
        body: 'Tap your node for interest, then hold to commit. Drag while committed to change ETA (max 30s).',
      }
    }
    if (script.step === 'commit') {
      return {
        title: 'Crowd Is Forming',
        body: 'The faux users follow Biology-style state changes and ETAs. Keep your commitment and watch the group lock in.',
      }
    }
    return {
      title: 'Group Ready',
      body: 'You formed a full group (min 5). Celebration mode is live.',
    }
  })()

  return (
    <main className={`room-page room-${theme}`}>
      <RoomCanvas
        activity={activity}
        participants={participants}
        me={me}
        visual={{ nodeRadius: 20, outlineWidth: 2, clusterTightness: 1.2 }}
        onInterested={onInterested}
        onCommit={onCommit}
        onWithdraw={onWithdraw}
        onAlert={() => {}}
        alreadyCommittedElsewhere={false}
        otherCommittedRoomCode={null}
      />
      <button type="button" className="room-code">/FOLD</button>
      <div className="tutorial-room-hud">
        <Coachmark
          title={coach.title}
          body={coach.body}
          onNext={
            script.isLast
              ? () => {
                  crowdRef.current = buildFakeCrowd(4)
                  setSelf({ state: 'lurker', arrivalAt: null })
                  setCrowdStarted(false)
                  setPartyActive(false)
                  setCrowdTick((n) => n + 1)
                  script.reset()
                }
              : script.next
          }
          nextLabel={script.isLast ? 'Replay' : 'Next'}
        />
        <div className="tutorial-links">
          <Link to="/fold">Homepage tutorial</Link>
          <Link to="/">Live homepage</Link>
        </div>
      </div>
      <RoomPanel
        activity={activity}
        theme={theme}
        onThemeToggle={toggleTheme}
        onInfo={() => {}}
        onProposeRun={() => {}}
        onOpenPolicy={() => {}}
      />
      <PartyBurst active={partyActive} />
    </main>
  )
}
