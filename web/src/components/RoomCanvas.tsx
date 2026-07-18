import { useEffect, useMemo, useRef } from 'react'
import { forceMonochromePresentation } from '../emoji'
import {
  DEFAULT_ETA_SEC,
  HOLD_MS,
  MAX_ETA_SEC,
  MIN_ETA_SEC,
  etaFromHold,
  getCssVar,
  nodeColor,
  targetOpacity,
  visualState,
  type VisualConfig,
  type VisualNodeState,
} from '../nodeVisual'
import { createTugModel, tugPositionInward, tugPositionOutward } from '../tugOfWar'
import type { ActivityView, ParticipantView, Person } from '../types'

export interface RoomAlertInput {
  message: string
  href?: string
  hrefLabel?: string
}

interface Props {
  activity: ActivityView
  participants: ParticipantView[]
  me: Person
  visual: VisualConfig
  onInterested: () => Promise<void>
  onCommit: (etaSeconds: number) => Promise<void>
  onWithdraw: () => Promise<void>
  onAlert: (message: string | RoomAlertInput) => void
  alreadyCommittedElsewhere: boolean
  otherCommittedRoomCode?: string | null
}

interface SimNode {
  id: string
  state: VisualNodeState
  arrivalAt: number | null
  isMe: boolean
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  /** Last heartbeat for this participant, null for your own synthetic
   * lurker node (always reachable) -- see nodeVisual.targetOpacity. */
  lastSeenAt: number | null
  /** Rendered opacity, eased toward targetOpacity() each frame -- never
   * snapped, so reachability/removal always animates. */
  opacity: number
  /** True once the server has dropped this participant (despondent reap or
   * event-over) and it's no longer in the polled participant list. Kept in
   * the sim and animated outward-and-fading for EXIT_MS instead of being
   * removed instantly -- see the reconciliation effect and frame loop. */
  exiting: boolean
  exitStartedAt: number | null
}

interface PointerState {
  id: number
  node: SimNode | null
  startX: number
  startY: number
  clientX: number
  clientY: number
  /** Latest world position for the held node, updated on every move. Read
   * every animation frame (not just on move events) so tug-of-war timing
   * keeps counting even while the pointer holds perfectly still. */
  worldX: number
  worldY: number
  downAt: number
  dragging: boolean
}

interface Camera { x: number; y: number; scale: number }

const WORLD_R = 280
const ABS_MAX_ETA_SEC = 24 * 60 * 60
const ABS_MAX_DURATION_SEC = 24 * 60 * 60
const TUG = createTugModel(WORLD_R)

// Resting radii for the two "outer" states, so every state has an explicit
// target position (not just committed/arrived, which are ETA/cluster-driven
// -- see computeTargets). Centered in each tug zone's band, so a
// state change always visibly travels from one ring to the next rather than
// snapping or lingering wherever it happened to be:
//   committed/arrived: 0..commitMaxR (ETA/cluster-driven, unchanged)
//   interested:         ~midway between commitMaxR and interestedMaxR
//   lurker (and any node the server has removed, mid-exit-animation):
//                        just outside interestedMaxR
const INTERESTED_R = (TUG.commitMaxR + TUG.interestedMaxR) / 2
const LURKER_R = TUG.interestedMaxR + 12
/** How long the fade+outward-travel plays before a removed node is actually
 * dropped from the sim -- see the reconciliation effect and frame loop. */
const EXIT_MS = 900
/** Per-frame opacity easing rate (matches the SPRING_DAMPING feel used for
 * position). */
const OPACITY_EASE = 0.12

// Each state boundary is a "tug of war" zone that works in both directions:
// pulling a node past the boundary away from center clings toward the edge
// (approaching, but never reaching, the outward asymptote) instead of
// tracking the pointer directly. Pulling the node back past the boundary
// toward center works the same way in reverse, clinging from the other
// side. Winning a tug is based on accumulated *work* (force x time), not
// time alone: "force" is how far past the boundary you're actually
// pulling (the raw, unresisted pointer distance beyond it, not the
// resisted on-screen position) -- pull harder and it wins faster; barely
// cross the line and it can take a very long time, since force is nearly
// zero. TUG_WIDTH_HOLD_MS is the time it takes to win while pulling at
// exactly one TUG_WIDTH past the boundary, used only to calibrate the work
// target to a familiar timescale.
// Same mass/damping a committed node uses to spring toward its target in
// step() -- reused here so a tug settles with that identical easing,
// including the moment it's won and the target radius jumps zones.
const SPRING_MASS = 0.04
const SPRING_DAMPING = 0.82
function springToward(n: SimNode, targetX: number, targetY: number) {
  n.vx += (targetX - n.x) * SPRING_MASS
  n.vy += (targetY - n.y) * SPRING_MASS
  n.vx *= SPRING_DAMPING
  n.vy *= SPRING_DAMPING
  n.x += n.vx
  n.y += n.vy
}

/** After winning a tug, keep spring-easing (instead of snapping straight to
 * 1:1 tracking) for this long, even if the new state's raw pointer distance
 * already reads as "in bounds" -- otherwise winning right at a zone
 * boundary could still jump. */
const WIN_EASE_MS = 300

export function RoomCanvas({
  activity,
  participants,
  me,
  visual,
  onInterested,
  onCommit,
  onWithdraw,
  onAlert,
  alreadyCommittedElsewhere,
  otherCommittedRoomCode,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const pointerRef = useRef<PointerState | null>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const pinchRef = useRef<{ dist: number } | null>(null)
  const visualRef = useRef(visual)
  const activityRef = useRef(activity)
  const busyRef = useRef(false)
  /** Accumulated tug-of-war work (force x time, in world-units x ms) --
   * reset to 0 whenever not currently tugging. */
  const tugWorkRef = useRef(0)
  /** performance.now() of the last frame that contributed to tugWorkRef --
   * null right when a tug starts, so the first frame contributes no time
   * (there's nothing to measure a duration against yet). */
  const tugLastFrameRef = useRef<number | null>(null)
  /** performance.now() deadline: while now is before this, keep spring-
   * easing toward the target even if it reads as back in bounds -- sets
   * right after winning a tug so the hand-off never snaps. */
  const winEaseUntilRef = useRef(0)
  const commitLockRef = useRef(alreadyCommittedElsewhere)
  const otherCommittedRoomCodeRef = useRef<string | null | undefined>(otherCommittedRoomCode)
  const guardAlertRef = useRef(0)
  const expireNoticeArrivalRef = useRef<number | null>(null)
  const myStableNodeIdRef = useRef(`me-${me.id}`)
  visualRef.current = visual
  activityRef.current = activity

  const source = useMemo(() => {
    const now = Date.now()
    const meParticipant = participants.find((p) => p.is_me)
    if (meParticipant) myStableNodeIdRef.current = meParticipant.id
    const nodes: Array<{
      id: string
      state: VisualNodeState
      arrivalAt: number | null
      isMe: boolean
      lastSeenAt: number | null
    }> = participants.map((p) => ({
      id: p.id,
      state: visualState(p, now),
      arrivalAt: p.arrival_at,
      isMe: p.is_me,
      lastSeenAt: p.last_seen_at,
    }))
    if (!nodes.some((n) => n.isMe)) {
      nodes.unshift({
        id: myStableNodeIdRef.current,
        state: 'lurker' as const,
        arrivalAt: null,
        isMe: true,
        lastSeenAt: null,
      })
    }
    return nodes
  }, [participants])

  useEffect(() => {
    commitLockRef.current = alreadyCommittedElsewhere
  }, [alreadyCommittedElsewhere])

  useEffect(() => {
    otherCommittedRoomCodeRef.current = otherCommittedRoomCode
  }, [otherCommittedRoomCode])

  useEffect(() => {
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]))
    const existingMe = nodesRef.current.find((n) => n.isMe)
    const sourceIds = new Set(source.map((s) => s.id))

    const next = source.map((s, index) => {
      let old = existing.get(s.id)
      if (!old && s.isMe) old = existingMe
      if (old) {
        if (old.id !== s.id) old.id = s.id
        const pointerOwnsNode = pointerRef.current?.node === old
        if (!pointerOwnsNode) {
          old.state = s.state
          old.arrivalAt = s.arrivalAt
        }
        old.isMe = s.isMe
        old.lastSeenAt = s.lastSeenAt
        old.exiting = false
        old.exitStartedAt = null
        return old
      }
      // New participant: place it already at its resting ring (rather than
      // an arbitrary interior point) so there's no jarring initial jump --
      // committed/arrived still snap toward their ETA/cluster target over
      // the following frames via the normal spring.
      const angle = s.isMe ? -Math.PI / 2 : (index / Math.max(1, source.length)) * Math.PI * 2
      const isOuter = s.state === 'lurker' || s.state === 'interested'
      const restR = s.isMe
        ? WORLD_R + visual.nodeRadius + 40
        : s.state === 'interested'
          ? INTERESTED_R
          : s.state === 'lurker'
            ? LURKER_R
            : WORLD_R * 0.6
      return {
        ...s,
        x: Math.cos(angle) * restR,
        y: Math.sin(angle) * restR,
        vx: 0,
        vy: 0,
        angle,
        opacity: isOuter || s.isMe ? 1 : 0,
        exiting: false,
        exitStartedAt: null,
      }
    })

    // A participant that dropped out of `source` (the server reaped a
    // despondent or event-over participation) keeps animating -- outward to
    // the lurker ring, fading out -- instead of vanishing the instant a poll
    // resolves. Purged for real in the frame loop once EXIT_MS elapses.
    for (const n of nodesRef.current) {
      if (n.isMe || sourceIds.has(n.id)) continue
      if (!n.exiting) {
        n.exiting = true
        n.exitStartedAt = performance.now()
      }
      next.push(n)
    }

    nodesRef.current = next
  }, [source, visual.nodeRadius])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect()
      const cam = cameraRef.current
      return {
        x: (cx - rect.left - rect.width / 2 - cam.x) / cam.scale,
        y: (cy - rect.top - rect.height / 2 - cam.y) / cam.scale,
      }
    }

    const hitMe = (x: number, y: number) => {
      const r = visualRef.current.nodeRadius + 4
      const meNode = nodesRef.current.find((n) => n.isMe)
      if (meNode && Math.hypot(meNode.x - x, meNode.y - y) <= r) return meNode
      return null
    }

    // Grab hand everywhere else on the canvas, crosshair when hovering your
    // own node, a closed fist while actively panning, and hidden entirely
    // while actually holding/dragging the node (nothing useful to point at
    // once you're moving it -- your view is on the node itself).
    const setCursor = (cursor: 'grab' | 'grabbing' | 'crosshair' | 'none') => {
      canvas.style.cursor = cursor
    }

    const activePointers = new Map<number, PointerEvent>()

    const call = async (fn: () => Promise<void>) => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        await fn()
      } catch (err) {
        onAlert(err instanceof Error ? err.message : String(err))
      } finally {
        busyRef.current = false
      }
    }

    const resetTug = () => {
      tugWorkRef.current = 0
      tugLastFrameRef.current = null
    }

    /** Adds this frame's work (force x elapsed time) to the running total
     * and reports whether the tug is won. `force` is how far past the
     * boundary the raw pointer currently is (unresisted, world units). */
    const advanceTugWork = (force: number) => {
      const nowPerf = performance.now()
      const last = tugLastFrameRef.current
      tugLastFrameRef.current = nowPerf
      if (last == null) return false // first frame of this tug: no elapsed time to measure yet
      tugWorkRef.current += force * (nowPerf - last)
      return tugWorkRef.current >= TUG.workNeeded
    }

    const guardCommit = () => {
      if (!commitLockRef.current) return false
      if (performance.now() - guardAlertRef.current > 900) {
        guardAlertRef.current = performance.now()
        const code = otherCommittedRoomCodeRef.current
        if (code) {
          onAlert({
            message: 'Already committed at {link} — withdraw there first.',
            href: `/${code}`,
            hrefLabel: code,
          })
        } else {
          onAlert('Already committed elsewhere — withdraw there first.')
        }
      }
      resetTug()
      winEaseUntilRef.current = performance.now() + WIN_EASE_MS
      return true
    }

    // Runs every animation frame (not just on pointer-move events) so a tug
    // of war keeps accumulating work even while the pointer holds
    // perfectly still at the stretched position -- matching "hold it out
    // there to win", not "keep wiggling it to win". Pulling farther still
    // wins faster, since force scales with distance past the boundary.
    const processHeldNode = (now: number) => {
      const ps = pointerRef.current
      if (!ps || !ps.node) return
      const activity = activityRef.current
      const maxEta = activityMaxEta(activity)
      const rawR = Math.hypot(ps.worldX, ps.worldY)
      const angle = rawR > 1 ? Math.atan2(ps.worldY, ps.worldX) : ps.node.angle
      ps.node.angle = angle
      const easing = performance.now() < winEaseUntilRef.current

      if (ps.node.state === 'committed' || ps.node.state === 'arrived') {
        // Committed/arrived has no inward tug -- it's already the innermost
        // tier, and closer to center just means a sooner ETA.
        if (rawR <= TUG.commitMaxR && !easing) {
          ps.node.x = ps.worldX
          ps.node.y = ps.worldY
          ps.node.vx = 0
          ps.node.vy = 0
          resetTug()
          const newArrivalAt = now + etaFromDistance(ps.worldX, ps.worldY, maxEta) * 1_000
          ps.node.arrivalAt = newArrivalAt
          if (ps.node.state === 'arrived' && newArrivalAt > now) ps.node.state = 'committed'
          return
        }
        // Tug of war: spring toward the resisted edge (same easing as a
        // committed node's normal homing animation) instead of snapping --
        // this also covers the moment the tug is won, when the target
        // jumps zones. Pinned at the max ETA while it clings to the edge.
        const targetR = tugPositionOutward(rawR, TUG.commitMaxR, TUG.commitOutTugR)
        springToward(ps.node, Math.cos(angle) * targetR, Math.sin(angle) * targetR)
        if (rawR <= TUG.commitMaxR) return // easing back in from a just-won transition
        ps.node.state = 'committed'
        ps.node.arrivalAt = now + maxEta * 1_000
        if (advanceTugWork(rawR - TUG.commitMaxR)) {
          ps.node.state = 'interested'
          resetTug()
          winEaseUntilRef.current = performance.now() + WIN_EASE_MS
          void call(onInterested)
        }
        return
      }

      if (ps.node.state === 'interested') {
        const inBounds = rawR >= TUG.commitMaxR && rawR <= TUG.interestedMaxR
        if (inBounds && !easing) {
          ps.node.x = ps.worldX
          ps.node.y = ps.worldY
          ps.node.vx = 0
          ps.node.vy = 0
          resetTug()
          return
        }
        if (rawR < TUG.commitMaxR) {
          // Pulled in toward center past the commit boundary: tug of war
          // in reverse -- winning promotes to committed.
          const targetR = tugPositionInward(rawR, TUG.commitMaxR, TUG.commitInTugR)
          springToward(ps.node, Math.cos(angle) * targetR, Math.sin(angle) * targetR)
          if (rawR >= TUG.commitMaxR) return
           if (advanceTugWork(TUG.commitMaxR - rawR)) {
             if (commitLockRef.current) {
               guardCommit()
               return
             }
             const eta = etaFromDistance(ps.worldX, ps.worldY, maxEta)
             ps.node.state = 'committed'
             ps.node.arrivalAt = now + eta * 1_000
             resetTug()
             winEaseUntilRef.current = performance.now() + WIN_EASE_MS
             void call(() => onCommit(eta))
           }
          return
        }
        // Pulled out past the lurker boundary (or easing back in from a
        // just-won transition): normal outward tug -- winning demotes.
        const targetR = tugPositionOutward(rawR, TUG.interestedMaxR, TUG.interestedOutTugR)
        springToward(ps.node, Math.cos(angle) * targetR, Math.sin(angle) * targetR)
        if (rawR <= TUG.interestedMaxR) return
        if (advanceTugWork(rawR - TUG.interestedMaxR)) {
          ps.node.state = 'lurker'
          resetTug()
          winEaseUntilRef.current = performance.now() + WIN_EASE_MS
          void call(onWithdraw)
        }
        return
      }

      // Lurker: free 1:1 tracking above the interested boundary, no further
      // demotion below this state. Pulled in past the boundary, the same
      // reverse tug of war applies -- winning promotes to interested.
      if (rawR >= TUG.interestedMaxR && !easing) {
        ps.node.x = ps.worldX
        ps.node.y = ps.worldY
        ps.node.vx = 0
        ps.node.vy = 0
        resetTug()
        return
      }
      const targetR = tugPositionInward(rawR, TUG.interestedMaxR, TUG.interestedInTugR)
      springToward(ps.node, Math.cos(angle) * targetR, Math.sin(angle) * targetR)
      if (rawR >= TUG.interestedMaxR) return
      if (advanceTugWork(TUG.interestedMaxR - rawR)) {
        ps.node.state = 'interested'
        resetTug()
        winEaseUntilRef.current = performance.now() + WIN_EASE_MS
        void call(onInterested)
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, e)
      canvas.setPointerCapture(e.pointerId)
      if (activePointers.size === 2) {
        const pts = [...activePointers.values()]
        pinchRef.current = { dist: Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY) }
        pointerRef.current = null
        return
      }
      const p = toWorld(e.clientX, e.clientY)
      const node = hitMe(p.x, p.y)
      resetTug()
      pointerRef.current = {
        id: e.pointerId,
        node,
        startX: p.x,
        startY: p.y,
        clientX: e.clientX,
        clientY: e.clientY,
        worldX: p.x,
        worldY: p.y,
        downAt: performance.now(),
        dragging: false,
      }
      setCursor(node ? 'none' : 'grabbing')
    }

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, e)
      if (activePointers.size === 2 && pinchRef.current) {
        const pts = [...activePointers.values()]
        const newDist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY)
        cameraRef.current.scale = Math.min(4, Math.max(0.2, cameraRef.current.scale * (newDist / Math.max(1, pinchRef.current.dist))))
        pinchRef.current.dist = newDist
        return
      }

      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) {
        // Hover only (no active gesture for this pointer): keep the cursor
        // in sync with whether we're over the node right now.
        if (e.pointerType === 'mouse') {
          const p = toWorld(e.clientX, e.clientY)
          setCursor(hitMe(p.x, p.y) ? 'crosshair' : 'grab')
        }
        return
      }
      if (!ps.node) {
        const dx = e.clientX - ps.clientX
        const dy = e.clientY - ps.clientY
        if (Math.hypot(e.clientX - ps.clientX, e.clientY - ps.clientY) > 0) ps.dragging = true
        cameraRef.current.x += dx
        cameraRef.current.y += dy
        ps.clientX = e.clientX
        ps.clientY = e.clientY
        setCursor('grabbing')
        return
      }

      setCursor('none')
      const p = toWorld(e.clientX, e.clientY)
      if (Math.hypot(p.x - ps.startX, p.y - ps.startY) > 6) ps.dragging = true
      // Just record where the pointer is in world space -- processHeldNode
      // (run every animation frame) does the actual positioning/state work,
      // so tugging keeps progressing even if the pointer stops moving.
      ps.worldX = p.x
      ps.worldY = p.y
    }

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) pinchRef.current = null
      const ps = pointerRef.current
      if (!ps || ps.id !== e.pointerId) return
      pointerRef.current = null
      resetTug()
      if (e.pointerType === 'mouse') {
        const p = toWorld(e.clientX, e.clientY)
        setCursor(hitMe(p.x, p.y) ? 'crosshair' : 'grab')
      }
      if (!ps.node) return

      const held = performance.now() - ps.downAt
      if (ps.dragging) {
        // If a tug of war demoted the node mid-drag, that already made its
        // own API call -- only committed/arrived still needs its ETA saved.
        if (ps.node.state !== 'committed' && ps.node.state !== 'arrived') return
        const eta = etaFromDistance(ps.node.x, ps.node.y, activityMaxEta(activityRef.current))
        void call(() => onCommit(eta))
        return
      }
      if (ps.node.state === 'lurker') {
        ps.node.state = 'interested'
        void call(onInterested)
      } else if (ps.node.state === 'interested' && held > 200) {
        if (commitLockRef.current) {
          guardCommit()
          ps.node.state = 'interested'
          return
        }
        const eta = scaleHoldEta(etaFromHold(held), activityMaxEta(activityRef.current))
        ps.node.state = 'committed'
        ps.node.arrivalAt = Date.now() + eta * 1_000
        void call(() => onCommit(eta))
      }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cameraRef.current.scale = Math.min(4, Math.max(0.2, cameraRef.current.scale * (e.deltaY < 0 ? 1.08 : 0.92)))
    }

    const onPointerLeave = () => {
      if (!pointerRef.current) setCursor('grab')
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let raf = 0
    const frame = () => {
      const now = Date.now()
      for (const n of nodesRef.current) {
        if (n.state === 'committed' && n.arrivalAt != null && n.arrivalAt <= now) n.state = 'arrived'
      }
      processHeldNode(now)
      const durationMs = activityDuration(activityRef.current) * 1_000
      for (const n of nodesRef.current) {
        if (pointerRef.current?.node === n) continue
        if (n.state === 'arrived' && n.arrivalAt != null && now - n.arrivalAt >= durationMs) {
          // Local prediction, ahead of the next poll: the server
          // independently reaps the same condition (event-over) and, if
          // this participant is still reachable, reverts them to lurker
          // rather than removing them -- see db::reap_run. Calling
          // onWithdraw here is just an idempotent nudge so *this* client
          // doesn't have to wait a full poll cycle to see it.
          const expiredArrivalAt = n.arrivalAt
          n.state = 'lurker'
          n.arrivalAt = null
          if (n.isMe) {
            if (expireNoticeArrivalRef.current !== expiredArrivalAt) {
              expireNoticeArrivalRef.current = expiredArrivalAt
              onAlert('Your spot expired — commit again to rejoin')
            }
            void call(onWithdraw)
          }
        }
      }

      // Ease every node's opacity toward its target tier (reachable / dimmed
      // / fading out) -- see nodeVisual.targetOpacity. Own node is always
      // fully opaque.
      for (const n of nodesRef.current) {
        const target = targetOpacity({ isMe: n.isMe, exiting: n.exiting, lastSeenAt: n.lastSeenAt, now })
        n.opacity += (target - n.opacity) * OPACITY_EASE
      }
      // Purge nodes that finished their exit animation (server-removed
      // participant that's now fully faded + traveled out to the lurker
      // ring) -- only reallocate the array when something actually needs
      // dropping.
      if (nodesRef.current.some((n) => n.exiting && n.exitStartedAt != null && performance.now() - n.exitStartedAt > EXIT_MS)) {
        nodesRef.current = nodesRef.current.filter(
          (n) => !(n.exiting && n.exitStartedAt != null && performance.now() - n.exitStartedAt > EXIT_MS),
        )
      }

      step(nodesRef.current, pointerRef.current, activityRef.current, visualRef.current, now)
      draw(ctx, canvas, nodesRef.current, pointerRef.current, cameraRef.current, visualRef.current, activityRef.current, now)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [onAlert, onCommit, onInterested, onWithdraw])

  return <canvas ref={canvasRef} className="room-canvas" />
}

// Every node now gets an explicit target from computeTargets (lurker and
// interested included, not just committed/arrived) and springs toward it
// uniformly -- so demotion/fade-back/removal always visibly travels through
// the same zones a node arrived through, instead of lingering wherever it
// happened to be (there used to be no target at all for lurker/interested).
function step(nodes: SimNode[], pointer: PointerState | null, activity: ActivityView, vis: VisualConfig, now: number) {
  const targets = computeTargets(nodes, activity, vis, now)
  // Only a still-clustered arrived node repels others away from the group;
  // one that's mid-exit-animation is leaving the cluster, not part of it.
  const arrived = nodes.filter((n) => n.state === 'arrived' && !n.exiting)
  for (const n of nodes) {
    if (pointer?.node === n) continue
    const t = targets.get(n.id) ?? { x: 0, y: 0 }
    n.vx += (t.x - n.x) * 0.04
    n.vy += (t.y - n.y) * 0.04
    n.vx *= 0.82
    n.vy *= 0.82

    // Nodes not fused into a committed/arrived cluster (lurker, interested,
    // or anything currently exiting regardless of its last known state)
    // additionally get pushed away from arrived clusters, so they visibly
    // part around a fused group instead of drifting through it.
    const clustered = (n.state === 'committed' || n.state === 'arrived') && !n.exiting
    if (!clustered) {
      const repulseR = vis.nodeRadius * 6
      for (const src of arrived) {
        if (src === n) continue
        const dx = n.x - src.x
        const dy = n.y - src.y
        const dist = Math.max(1, Math.hypot(dx, dy))
        if (dist < repulseR) {
          const force = ((repulseR - dist) / repulseR) * 0.6
          n.vx += (dx / dist) * force
          n.vy += (dy / dist) * force
        }
      }
    }
    n.x += n.vx
    n.y += n.vy
  }
}

function computeTargets(nodes: SimNode[], activity: ActivityView, vis: VisualConfig, now: number) {
  const targets = new Map<string, { x: number; y: number }>()
  // Exiting nodes are always headed out to the lurker ring, never into a
  // cluster, regardless of what they were committed/interested as before
  // the server removed them.
  const committed = nodes.filter((n) => !n.exiting && (n.state === 'committed' || n.state === 'arrived'))
  const arrived = committed.filter((n) => n.state === 'arrived')
  const inFlight = committed.filter((n) => n.state === 'committed')
  const groupSizes = activity.current_run?.group.group_sizes ?? []
  const orbitR = vis.nodeRadius * vis.clusterTightness
  const maxEta = activityMaxEta(activity)
  const etaSpanMs = Math.max(1, maxEta * 1_000)
  const defaultEtaMs = Math.min(maxEta, DEFAULT_ETA_SEC) * 1_000

  if (activity.grouping_mode === 'single') {
    placeGroup(targets, arrived, { x: 0, y: 0 }, orbitR)
  } else {
    const groups = groupBySizes(arrived, groupSizes.length > 0 ? groupSizes : [arrived.length])
    const centers = groupCenters(groups.length, activity.group_multiple, orbitR)
    groups.forEach((group, i) => placeGroup(targets, group, centers[i] ?? { x: 0, y: 0 }, orbitR))
  }

  for (const n of inFlight) {
    const remaining = n.arrivalAt == null ? defaultEtaMs : Math.max(0, Math.min(etaSpanMs, n.arrivalAt - now))
    const r = (remaining / etaSpanMs) * WORLD_R
    targets.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r })
  }

  // Everything else -- lurker, interested, and any exiting node regardless
  // of its last known state -- rests on a fixed ring along its own angle,
  // rather than having no target (the previous behavior for lurker/
  // interested: only repulsion, no homing, so a demoted/removed node just
  // lingered near the center instead of visibly retreating outward).
  for (const n of nodes) {
    if (targets.has(n.id)) continue
    const r = !n.exiting && n.state === 'interested' ? INTERESTED_R : LURKER_R
    targets.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r })
  }
  return targets
}

function placeGroup(targets: Map<string, { x: number; y: number }>, group: SimNode[], center: { x: number; y: number }, orbitR: number) {
  group.forEach((n, i) => {
    const r = group.length <= 1 ? 0 : orbitR
    const a = group.length <= 1 ? 0 : (i / group.length) * Math.PI * 2
    targets.set(n.id, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })
  })
}

function groupBySizes(nodes: SimNode[], sizes: number[]) {
  const groups: SimNode[][] = []
  let idx = 0
  for (const size of sizes) {
    groups.push(nodes.slice(idx, idx + size))
    idx += size
  }
  if (idx < nodes.length) groups.push(nodes.slice(idx))
  return groups.filter((g) => g.length > 0)
}

function groupCenters(count: number, perGroup: number, orbitR: number): Array<{ x: number; y: number }> {
  if (count <= 1) return [{ x: 0, y: 0 }]
  const ringR = Math.max(orbitR * 2.8, ((orbitR * 2 * count * Math.max(2, perGroup)) / (2 * Math.PI)) * 0.7)
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR }
  })
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nodes: SimNode[],
  pointer: PointerState | null,
  camera: Camera,
  vis: VisualConfig,
  activity: ActivityView,
  now: number,
) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = getCssVar('--bg')
  ctx.fillRect(0, 0, w, h)

  const isDragging = !!pointer?.dragging
  ctx.save()
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  ctx.scale(camera.scale, camera.scale)
  // Rings are drawn in --text at a low alpha (not a hardcoded rgba string)
  // so they read correctly against either theme's background, and fade in
  // while manipulating a node -- same as Biology's isDragging-based alpha.
  ctx.globalAlpha = isDragging ? 0.08 : 0.02
  ctx.strokeStyle = getCssVar('--text')
  ctx.lineWidth = 1 / camera.scale
  for (let r = 80; r <= WORLD_R; r += 80) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.restore()

  const dpr = canvas.width / Math.max(1, w)
  const layer = document.createElement('canvas')
  layer.width = canvas.width
  layer.height = canvas.height
  const lctx = layer.getContext('2d')
  if (!lctx) return
  lctx.scale(dpr, dpr)
  lctx.translate(w / 2 + camera.x, h / 2 + camera.y)
  lctx.scale(camera.scale, camera.scale)

  for (const n of nodes) {
    // Reachable participants are fully opaque; unreachable ones dim to
    // ~50%, and exiting (server-removed) ones fade all the way to 0 as they
    // travel out to the lurker ring -- eased every frame in the sim loop
    // (see nodeVisual.targetOpacity), never snapped.
    lctx.globalAlpha = Math.max(0, Math.min(1, n.opacity))
    lctx.fillStyle = nodeColor(n.state)
    lctx.beginPath()
    lctx.arc(n.x, n.y, vis.nodeRadius, 0, Math.PI * 2)
    lctx.fill()
  }
  // Reset before the outline pass: that punch-through should always be
  // fully opaque regardless of the last-drawn node's opacity, or it
  // wouldn't fully cut the outline hole.
  lctx.globalAlpha = 1
  lctx.globalCompositeOperation = 'destination-out'
  lctx.strokeStyle = '#000'
  lctx.fillStyle = '#000'
  if (vis.outlineWidth > 0) {
    lctx.lineWidth = vis.outlineWidth
    for (const n of nodes) {
      lctx.beginPath()
      lctx.arc(n.x, n.y, vis.nodeRadius, 0, Math.PI * 2)
      lctx.stroke()
    }
  }

  const labelNode: SimNode | null = (() => {
    if (!pointer) return null
    if (pointer.dragging && (pointer.node?.state === 'committed' || pointer.node?.state === 'arrived')) return pointer.node
    if (!pointer.dragging && pointer.node?.state === 'interested' && performance.now() - pointer.downAt > 50) return pointer.node
    return null
  })()
  if (labelNode) {
    // Left in 'destination-out' (not reset to source-over): the label is
    // punched through the node's fill as a cutout, exactly like Biology --
    // not drawn as solid text on top.
    const fs = Math.max(9, Math.round(vis.nodeRadius * 0.52))
    lctx.font = `700 ${fs}px Manrope, sans-serif`
    lctx.textAlign = 'center'
    lctx.textBaseline = 'middle'
    const maxEta = activityMaxEta(activity)
    const eta = labelNode.state === 'interested'
      ? scaleHoldEta(etaFromHold(Math.min(HOLD_MS, performance.now() - pointer!.downAt)), maxEta)
      : etaRemainingSeconds(labelNode.arrivalAt, now)
    lctx.fillText(formatEta(eta), labelNode.x, labelNode.y)
  }

  const activityGlyph = forceMonochromePresentation(activity.emoji)
  if (activityGlyph) {
    const fs = Math.max(12, Math.round(vis.nodeRadius * 0.9))
    lctx.font = `700 ${fs}px "Noto Emoji", sans-serif`
    lctx.textAlign = 'center'
    lctx.textBaseline = 'middle'
    for (const n of nodes) {
      if (n.isMe && n.state !== 'arrived' && n !== labelNode) {
        lctx.fillText(activityGlyph, n.x, n.y)
      }
    }
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

function etaFromDistance(x: number, y: number, maxEta: number) {
  const span = Math.max(MIN_ETA_SEC, maxEta)
  if (span === 0) return 0
  const t = Math.min(1, Math.max(0, Math.hypot(x, y) / WORLD_R))
  return Math.max(MIN_ETA_SEC, Math.min(span, Math.round(t * span)))
}

function scaleHoldEta(raw: number, maxEta: number) {
  if (maxEta <= 0) return 0
  return Math.round((raw / MAX_ETA_SEC) * maxEta)
}

function activityMaxEta(activity: ActivityView) {
  return clampNumber(activity.max_commit_seconds ?? MAX_ETA_SEC, 0, ABS_MAX_ETA_SEC)
}

function activityDuration(activity: ActivityView) {
  return clampNumber(activity.duration_seconds ?? DEFAULT_ETA_SEC, 0, ABS_MAX_DURATION_SEC)
}

function clampNumber(value: number, min: number, max: number) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function etaRemainingSeconds(arrivalAt: number | null, now: number) {
  if (arrivalAt == null) return DEFAULT_ETA_SEC
  return Math.max(0, Math.ceil((arrivalAt - now) / 1000))
}

function formatEta(etaSeconds: number) {
  if (etaSeconds >= 60) return `${Math.ceil(etaSeconds / 60)}m`
  return `${etaSeconds}s`
}
