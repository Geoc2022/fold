// TypeScript mirror of the Worker API views (src/models.rs, src/logic.rs).
//
// Activities are persistent tiles/templates (title, emoji, category, stable
// room code, grouping shape, lifetime stats). Each gathering is a "run"
// (time/location/status/participants). At most one run per activity is
// "current"; `current_run` is null when the room is empty (prompting a new
// proposal).

export type GroupingMode = 'single' | 'tiling'

export type RunStatus = 'open' | 'ready' | 'scheduled' | 'closed' | 'cancelled'

export type MyState = 'interested' | 'committed' | null

export interface Person {
  id: string
  handle: string
  color: string
  created_at: number
  last_seen_at: number
}

export interface GroupState {
  complete_groups: number
  group_sizes: number[]
  is_ready: boolean
  waiting_count: number
  spots_to_next: number | null
  spots_remaining: number | null
}

export interface RunView {
  id: string
  status: RunStatus
  location: string | null
  details: string | null
  scheduled_for: number | null
  expires_at: number | null
  interested_count: number
  committed_count: number
  created_at: number
  updated_at: number
  group: GroupState
}

export interface ActivityView {
  id: string
  code: string
  emoji: string
  title: string
  description: string | null
  category: string
  proposer_id: string
  proposer_handle: string | null
  min_people: number
  max_people: number | null
  group_multiple: number
  grouping_mode: GroupingMode
  allow_guests: boolean
  private_by_link: boolean
  duration_minutes: number
  max_commit_minutes: number
  times_run: number
  players_served: number
  interest_total: number
  commit_total: number
  /** commit_total / (interest_total + commit_total), or null if nobody has ever participated. */
  commit_pct: number | null
  last_active_at: number
  created_at: number
  updated_at: number
  /** The active/open run, or null when the room is currently empty. */
  current_run: RunView | null
  /** The requesting person's state in the current run: interested | committed | null. */
  my_state: MyState
}

export type NotificationKind =
  | 'activity_proposed'
  | 'run_proposed'
  | 'interest_added'
  | 'commit_added'
  | 'activity_interest_ready'
  | 'activity_ready'
  | 'activity_scheduled'
  | 'activity_closed'
  | 'activity_cancelled'
  | string

export interface Notification {
  id: string
  recipient_id: string
  activity_id: string | null
  run_id: string | null
  kind: NotificationKind
  message: string
  read_at: number | null
  created_at: number
}

export interface SyncResponse {
  server_time: number
  me: Person | null
  activities: ActivityView[]
  notifications: Notification[]
}

export interface ParticipantView {
  id: string
  color: string
  state: 'interested' | 'committed'
  arrival_at: number | null
  is_me: boolean
}

export interface RoomResponse {
  server_time: number
  activity: ActivityView
  participants: ParticipantView[]
  already_committed_elsewhere: boolean
  other_committed_room_code: string | null
  other_committed_activity_title: string | null
}

/** Creates a new activity (tile) plus its first run in one call. */
export interface CreateActivityInput {
  code?: string | null
  emoji?: string | null
  title: string
  description?: string | null
  category?: string | null
  min_people: number
  max_people?: number | null
  group_multiple?: number | null
  grouping_mode?: GroupingMode
  allow_guests?: boolean
  private_by_link?: boolean
  duration_minutes?: number | null
  max_commit_minutes?: number | null
  // First-run fields.
  location?: string | null
  details?: string | null
  scheduled_for?: number | null
  expires_at?: number | null
}

/** Creates a new run on an existing activity whose room is currently empty. */
export interface CreateRunInput {
  location?: string | null
  details?: string | null
  scheduled_for?: number | null
  expires_at?: number | null
}
