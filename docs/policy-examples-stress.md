# Policy stress examples

This file keeps additional policy scenarios used by compile/runtime parity tests.

## Sequencing with mixed effects

```policy
{
  if #committed >= min_people then
    notify "Quorum reached for {title}"
  else
    {},
  notify "Starts in 2" before ready_in by 2min,
  sleep 15s,
  notify "Last call"
}
```

<!-- policy-test
[
  {
    "name": "quorum reached with known ready time",
    "env": {
      "committed_count": 4,
      "min_people": 3,
      "ready_in_secs": 300,
      "title": "Evening Match"
    },
    "events": [
      { "after_secs": 0, "notify": "Quorum reached for Evening Match" },
      { "after_secs": 180, "notify": "Starts in 2" },
      { "after_secs": 195, "notify": "Last call" }
    ]
  },
  {
    "name": "below quorum with close ready time",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "ready_in_secs": 90,
      "title": "Evening Match"
    },
    "events": [
      { "after_secs": 0, "notify": "Starts in 2" },
      { "after_secs": 15, "notify": "Last call" }
    ]
  },
  {
    "name": "below quorum with unknown ready time",
    "env": {
      "committed_count": 1,
      "min_people": 3,
      "ready_in_secs": null,
      "title": "Evening Match"
    },
    "events": [
      { "after_secs": 15, "notify": "Last call" }
    ]
  }
]
-->
