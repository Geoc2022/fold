# Policy examples

These examples complement the generated reference in
`docs/language.md`.

## Interesting patterns

### Quorum notify

```policy
#committed >= min_people => notify "{#committed} committed"
```

### ETA adjustment with duration math

```policy
if #committed >= min_people then
  commit -3m
else
  commit +2m
```

### Notify before predicted ready time

```policy
notify "Game starts in 3 minutes" before ready_in by 3min
```

### Wait, then notify

```policy
{ sleep 20s, notify "yo" }
```

### Use list helpers

```policy
late = any (fun p -> waited p > 20min) committed
late => notify "Someone has waited over 20 minutes"
```

### Weekend behavior

```policy
is_weekend today => lurk
```

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
