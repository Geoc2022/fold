# Policy examples

These examples complement the generated reference in
`docs/language.md`.

## Interesting patterns

### Quorum notify

```policy
#committed >= min_people => notify "{#committed} committed"
```

<!-- policy-test
[
  {
    "name": "quorum above threshold",
    "env": {
      "committed_count": 4,
      "min_people": 3
    },
    "events": [
      { "after_secs": 0, "notify": "4 committed" }
    ]
  },
  {
    "name": "quorum at threshold",
    "env": {
      "committed_count": 3,
      "min_people": 3
    },
    "events": [
      { "after_secs": 0, "notify": "3 committed" }
    ]
  },
  {
    "name": "quorum below threshold",
    "env": {
      "committed_count": 2,
      "min_people": 3
    },
    "events": []
  }
]
-->

### ETA adjustment with duration math

```policy
if #committed >= min_people then
  commit -3m
else
  commit +2m
```

<!-- policy-test
[
  {
    "name": "eta adjustment when quorum reached",
    "env": {
      "committed_count": 3,
      "min_people": 3
    },
    "events": [
      { "after_secs": 0, "state": "committed", "eta_delta_secs": -180 }
    ]
  },
  {
    "name": "eta adjustment when quorum missing",
    "env": {
      "committed_count": 1,
      "min_people": 3
    },
    "events": [
      { "after_secs": 0, "state": "committed", "eta_delta_secs": 120 }
    ]
  }
]
-->

### Notify before predicted ready time

```policy
notify "Game starts in 3 minutes" before ready_in by 3min
```

<!-- policy-test
[
  {
    "name": "before ready_in with lead time",
    "env": {
      "ready_in_secs": 300
    },
    "events": [
      { "after_secs": 120, "notify": "Game starts in 3 minutes" }
    ]
  },
  {
    "name": "before ready_in when close",
    "env": {
      "ready_in_secs": 120
    },
    "events": [
      { "after_secs": 0, "notify": "Game starts in 3 minutes" }
    ]
  },
  {
    "name": "before ready_in when unknown",
    "env": {
      "ready_in_secs": null
    },
    "events": []
  }
]
-->

### Wait, then notify

```policy
{ sleep 20s, notify "yo" }
```

<!-- policy-test
[
  {
    "name": "sleep then notify baseline",
    "events": [
      { "after_secs": 20, "notify": "yo" }
    ]
  },
  {
    "name": "sleep then notify with different room vars",
    "env": {
      "committed_count": 4,
      "min_people": 5,
      "now_hour": 9,
      "now_minute": 15
    },
    "events": [
      { "after_secs": 20, "notify": "yo" }
    ]
  }
]
-->

### Use list helpers

```policy
late = any (fun p -> waited p > 20min) committed
late => notify "Someone has waited over 20 minutes"
```

<!-- policy-test
[
  {
    "name": "late committed participant triggers notify",
    "env": {
      "committed_count": 1,
      "committed_waited_secs": 1500
    },
    "events": [
      { "after_secs": 0, "notify": "Someone has waited over 20 minutes" }
    ]
  },
  {
    "name": "committed wait under threshold",
    "env": {
      "committed_count": 2,
      "committed_waited_secs": 600
    },
    "events": []
  }
]
-->

### Weekend behavior

```policy
is_weekend today => lurk
```

<!-- policy-test
[
  {
    "name": "weekend lurk",
    "env": {
      "today": "Sun"
    },
    "events": [
      { "after_secs": 0, "state": "lurker" }
    ]
  },
  {
    "name": "weekday no-op",
    "env": {
      "today": "Tue"
    },
    "events": []
  }
]
-->

## Notification policy templates

### After Work Board Games Example

```policy
five_pm_nudge =
  now.hour == 17 and now.minute == 0 and #committed < min_people

{
  if five_pm_nudge then
    notify "It is 5pm - submit your commits for {title}!"
  else
    {},
  notify "3 minutes till {title}" before ready_in by 3min
}
```

<!-- policy-test
[
  {
    "name": "after-work before 5pm",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "now_hour": 16,
      "now_minute": 59,
      "ready_in_secs": 300,
      "title": "After Work Board Games"
    },
    "events": [
      { "after_secs": 120, "notify": "3 minutes till After Work Board Games" }
    ]
  },
  {
    "name": "after-work at 5pm under quorum",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "now_hour": 17,
      "now_minute": 0,
      "ready_in_secs": 300,
      "title": "After Work Board Games"
    },
    "events": [
      { "after_secs": 0, "notify": "It is 5pm - submit your commits for After Work Board Games!" },
      { "after_secs": 120, "notify": "3 minutes till After Work Board Games" }
    ]
  },
  {
    "name": "after-work at 5pm already ready",
    "env": {
      "committed_count": 3,
      "min_people": 3,
      "now_hour": 17,
      "now_minute": 0,
      "ready_in_secs": 300,
      "title": "After Work Board Games"
    },
    "events": [
      { "after_secs": 120, "notify": "3 minutes till After Work Board Games" }
    ]
  },
  {
    "name": "after-work after 5pm",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "now_hour": 17,
      "now_minute": 1,
      "ready_in_secs": 300,
      "title": "After Work Board Games"
    },
    "events": [
      { "after_secs": 120, "notify": "3 minutes till After Work Board Games" }
    ]
  }
]
-->

### Lunch Example

```policy
(* commit at 12pm *)
lunch_nudge =
  now.hour == 12 and now.minute == 0 and #committed < min_people

{
  if lunch_nudge then
    notify "Lunch window is open - commit now for {title}."
  else
    {},
  notify "Lunch starts in 3 minutes" before ready_in by 3min
}
```

<!-- policy-test
[
  {
    "name": "lunch before noon",
    "env": {
      "committed_count": 0,
      "min_people": 2,
      "now_hour": 11,
      "now_minute": 59,
      "ready_in_secs": 300,
      "title": "Lunch"
    },
    "events": [
      { "after_secs": 120, "notify": "Lunch starts in 3 minutes" }
    ]
  },
  {
    "name": "lunch at noon under quorum",
    "env": {
      "committed_count": 0,
      "min_people": 2,
      "now_hour": 12,
      "now_minute": 0,
      "ready_in_secs": 300,
      "title": "Lunch"
    },
    "events": [
      { "after_secs": 0, "notify": "Lunch window is open - commit now for Lunch." },
      { "after_secs": 120, "notify": "Lunch starts in 3 minutes" }
    ]
  },
  {
    "name": "lunch after noon",
    "env": {
      "committed_count": 0,
      "min_people": 2,
      "now_hour": 12,
      "now_minute": 1,
      "ready_in_secs": 300,
      "title": "Lunch"
    },
    "events": [
      { "after_secs": 120, "notify": "Lunch starts in 3 minutes" }
    ]
  }
]
-->

### Pickup Sports Example

```policy
enough = #committed >= min_people

{
  if enough then
    commit -5m
  else
    interest,
  notify "Warm up. We'll be starting in 5" before ready_in by 5min
}
```

<!-- policy-test
[
  {
    "name": "pickup sports enough players",
    "env": {
      "committed_count": 4,
      "min_people": 3,
      "ready_in_secs": 600
    },
    "events": [
      { "after_secs": 0, "state": "committed", "eta_delta_secs": -300 },
      { "after_secs": 300, "notify": "Warm up. We'll be starting in 5" }
    ]
  },
  {
    "name": "pickup sports not enough players",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "ready_in_secs": 600
    },
    "events": [
      { "after_secs": 0, "state": "interested" },
      { "after_secs": 300, "notify": "Warm up. We'll be starting in 5" }
    ]
  },
  {
    "name": "pickup sports unknown ready_in",
    "env": {
      "committed_count": 4,
      "min_people": 3,
      "ready_in_secs": null
    },
    "events": [
      { "after_secs": 0, "state": "committed", "eta_delta_secs": -300 }
    ]
  }
]
-->
