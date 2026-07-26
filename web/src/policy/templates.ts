export interface PolicyTemplate {
  id: string
  label: string
  source: string
}

export const DEFAULT_NOTIFICATION_POLICY_TEMPLATE_ID = 'default'

export const NOTIFICATION_POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: 'default',
    label: 'Default',
    source: `quorum_reached = #committed >= min_people

{
  if quorum_reached then
    notify "{title} is ready with {#committed} committed"
  else
    {},
  notify "{title} starts in 3 minutes" before ready_in by 3min
}`,
  },
  {
    id: 'after-work',
    label: 'After Work',
    source: `five_pm_nudge =
  not is_weekend today and now.hour == 16 and now.minute == 50 and #committed < min_people

{
  if five_pm_nudge then
    notify "Submit your ETA for {title}!"
  else
    {},
  notify "3 minutes till {title}" before ready_in by 3min
}`,
  },
  {
    id: 'lunch',
    label: 'Lunch',
    source: `(* commit at 12pm *)
lunch_nudge =
  not is_weekend today and now.hour == 12 and now.minute == 0 and #committed < min_people

{
  if lunch_nudge then
    notify "It's noon - commit now for {title}."
  else
    {},
  notify "Lunch starts in 3 minutes" before ready_in by 3min
}`,
  },
  {
    id: 'pickup-sports',
    label: 'Pickup Sports',
    source: `enough = #committed >= min_people

{
  if enough then
    commit -5m
  else
    interest,
  notify "Warm up. We'll be starting in 5" before ready_in by 5min
}`,
  },
]
