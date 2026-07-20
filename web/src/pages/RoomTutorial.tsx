import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RoomCanvas } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'
import { PolicyPanel } from '../components/PolicyPanel'
import { requestNotificationPermission } from '../notify-client'
import { loadHomeRules, loadRoomRules, roomRulesKey, type PolicyRule } from '../policy/rules'
import { appendPolicySources, decodePolicySources, encodePolicySources } from '../policy/share'
import { writeJson } from '../storage'
import { buildActivityShareText } from '../activityShare'
import { Spotlight } from '../tutorial/Spotlight'
import { useTheme } from '../theme'
import type { ParticipantView } from '../types'
import { Coachmark } from '../tutorial/Coachmark'
import { advanceFakeCrowd, buildFakeCrowd, crowdAsParticipants } from '../tutorial/fakeCrowd'
import { foldTutorialActivity, tutorialMe } from '../tutorial/fakeRoom'
import { PartyBurst } from '../tutorial/PartyBurst'
import { useScript } from '../tutorial/useScript'

type SelfState = { state: 'lurker' | 'interested' | 'committed'; arrivalAt: number | null }

const SCRIPT = ['intro', 'lurker', 'interested', 'committed', 'ready'] as const

export function RoomTutorial() {
  const [searchParams, setSearchParams] = useSearchParams()
  const me = useMemo(() => tutorialMe(), [])
  const { theme, toggleTheme } = useTheme()
  const [self, setSelf] = useState<SelfState>({ state: 'lurker', arrivalAt: null })
  const [crowdStarted, setCrowdStarted] = useState(false)
  const [partyActive, setPartyActive] = useState(false)
  const crowdRef = useRef(buildFakeCrowd(4))
  const [crowdTick, setCrowdTick] = useState(0)
  const [showPolicyPanel, setShowPolicyPanel] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState('')
  const [rules, setRules] = useState<PolicyRule[]>(() => loadRoomRules('FOLD') ?? loadHomeRules())
  const script = useScript([...SCRIPT])

  const saveRules = (nextRules: PolicyRule[]) => {
    setRules(nextRules)
    writeJson(roomRulesKey('FOLD'), nextRules)
  }

  useEffect(() => {
    const policyParam = searchParams.get('policy')
    if (!policyParam) return
    try {
      const sources = decodePolicySources(policyParam)
      if (sources.length > 0) {
        saveRules(appendPolicySources(rules, sources))
        setShowPolicyPanel(true)
      }
    } catch {
      // Ignore malformed shared policy links in the tutorial too.
    }
    setSearchParams((current) => {
      current.delete('policy')
      return current
    }, { replace: true })
  }, [rules, searchParams, setSearchParams])

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
    void crowdTick
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
      script.set(4)
    }
  }, [groupReady, script])

  async function onInterested() {
    if (script.step !== 'lurker' && script.step !== 'ready') return
    setSelf({ state: 'interested', arrivalAt: null })
    if (!crowdStarted) {
      setCrowdStarted(true)
    }
    if (script.step === 'lurker') script.set(2)
  }

  async function onCommit(etaSeconds: number) {
    if (script.step !== 'interested' && script.step !== 'committed' && script.step !== 'ready') return
    setSelf({ state: 'committed', arrivalAt: Date.now() + etaSeconds * 1000 })
    if (script.step !== 'ready') script.set(3)
  }

  async function onWithdraw() {
    if (script.step === 'ready') setSelf({ state: 'lurker', arrivalAt: null })
  }

  const coach = (() => {
    if (script.step === 'intro') {
      return {
        title: 'Welcome to /FOLD',
        body: 'There are 3 types of people: lurkers, interested, and committed. And, as you move closer to the center, you progress borough these stages to join the group.',
      }
    }
    if (script.step === 'lurker') {
      return {
        title: 'Lurker',
        body: 'Your node starts on the edge. Press and hold on the background to become interested.',
      }
    }
    if (script.step === 'interested') {
      return {
        title: 'Interested',
        body: 'Looks like there are some other people who are interested too. To commit and complete the group, keep pressing and holding the background or pull it toward the center.',
      }
    }
    if (script.step === 'committed') {
      return {
        title: 'Committed',
        body: 'The group arrives when everyone makes it to the center, so ETA controls your distance from the center. Keep the commitment while the other four people arrive.',
      }
    }
    return {
      title: 'Group Ready!',
      body: 'The group is ready after all 5 people have committed (the min group size is 5). Go to the "Live homepage" to try out fold out for real',
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
        interactionPermissions={{
          interest: script.step === 'lurker' || script.step === 'ready',
          commit: script.step === 'interested' || script.step === 'committed' || script.step === 'ready',
          withdraw: script.step === 'ready',
        }}
      />
      <button type="button" className="room-code">/FOLD</button>
      <div className="tutorial-room-hud">
        <Coachmark
          title={coach.title}
          body={coach.body}
          onNext={script.step === 'intro'
            ? script.next
            : script.isLast
              ? () => {
                  crowdRef.current = buildFakeCrowd(4)
                  setSelf({ state: 'lurker', arrivalAt: null })
                  setCrowdStarted(false)
                  setPartyActive(false)
                  setCrowdTick((n) => n + 1)
                  script.reset()
                }
              : undefined
          }
          nextLabel={script.isLast ? 'Replay' : 'Start'}
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
        onOpenPolicy={() => setShowPolicyPanel(true)}
        onShare={() => {
          const url = `${window.location.origin}/FOLD`
          void navigator.clipboard.writeText(buildActivityShareText(activity, participants, Date.now(), url))
        }}
      />
      <Spotlight target={script.step === 'intro' ? '.room-code' : '.room-canvas'} />
      {showPolicyPanel && (
        <PolicyPanel
          rules={rules}
          onRulesChange={saveRules}
          onClose={() => setShowPolicyPanel(false)}
          hint="Rules in this tutorial are saved locally as a demo."
          notifyStatus={notifyStatus}
          onRequestNotifications={() => {
            void requestNotificationPermission().then(setNotifyStatus)
          }}
          onShare={() => {
            const url = `${window.location.origin}/FOLD?policy=${encodeURIComponent(encodePolicySources(rules))}`
            void navigator.clipboard.writeText(url)
          }}
        />
      )}
      <PartyBurst active={partyActive} />
    </main>
  )
}
