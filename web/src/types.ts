// TypeScript mirror of the Worker API views (src/models.rs, src/logic.rs).

export type GroupingMode = 'single' | 'tiling'

export type ActivityStatus =
  | 'open'
  | 'ready'
  | 'scheduled'
  | 'closed'
  | 'cancelled'

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

export interface ActivityView {
  id: string
  code: string | null
  title: string
  description: string | null
  proposer_id: string
  proposer_handle: string | null
  min_people: number
  max_people: number | null
  group_multiple: number
  grouping_mode: GroupingMode
  status: ActivityStatus
  location: string | null
  scheduled_for: number | null
  expires_at: number | null
  interested_count: number
  committed_count: number
  created_at: number
  updated_at: number
  group: GroupState
  my_state: MyState
}

export type NotificationKind =
  | 'activity_proposed'
  | 'activity_interest'
  | 'activity_commit'
  | 'activity_ready'
  | 'activity_scheduled'
  | 'activity_closed'
  | 'activity_cancelled'
  | string

export interface Notification {
  id: string
  recipient_id: string
  activity_id: string | null
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
}

export interface CreateActivityInput {
  code?: string | null
  title: string
  description?: string | null
  min_people: number
  max_people?: number | null
  group_multiple?: number | null
  grouping_mode?: GroupingMode
  location?: string | null
  scheduled_for?: number | null
  expires_at?: number | null
}
