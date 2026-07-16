# Policy language

A small, strongly-typed language for writing room policies. It reads like simplified OCaml. Two rules keep it consistent:

- **Commas gather data** — lists `[a, b, c]`, tuples `(a, b)`, records `{ x = 1 }`.
- **Spaces apply functions** — `map f xs`, `notify "hi"`. Never use commas in a call.

Newlines separate statements; there are no semicolons. A policy is just an expression that produces an `Action` — the last line is what the policy does. `condition => action` is shorthand for `if condition then action else {}` (do nothing).

## Syntax at a glance

```
count = #interested            (* a binding; # means "how many" *)
double x = x * 2               (* a function of one argument *)
add = fun a b -> a + b         (* the same, written with fun *)
label = if count > 3 then "many" else "few"
text = "we have {count} people"   (* string interpolation with { } *)
first = match items with
  | [] -> None
  | x :: rest -> Some(x)
count > min_people => notify "ready! ({count})"
```

## Operators

| Operator | Meaning |
|---|---|
| `+ - * / %` | arithmetic on `Num` (and `Dur`) |
| `== !=` | equality (any comparable type) |
| `< > <= >=` | ordering |
| `and or not xor` | boolean logic |
| `::` | prepend to a list |
| `#xs` | length of a list |
| `xs[i]` | list indexing (0-based) |
| `.field` / `.0` | record field / tuple element |

## Built-in types

```
type State = Lurker | Interested | Committed(Dur) | Arrived(Dur)
type Person = { name: Str, state: State }
type Option<a> = None | Some(a)
type Day = Mon | Tue | Wed | Thu | Fri | Sat | Sun
type Grouping = Single | Parallel
type Time = { hour: Num, minute: Num }
```

Primitive types: `Num`, `Bool`, `Dur` (durations like `1h30m`), `Str`, `Time`. Plus `List<T>`, tuples `(A, B)`, functions `A -> B`, and `Action`.

## Traits

Traits are shared behaviours (type classes). Operators use the built-in ones; you can declare your own with `trait` and `impl`.

```
trait Eq<a> {
  eq: a -> a -> Bool
}
trait Ord<a> {
  lt: a -> a -> Bool
  le: a -> a -> Bool
  gt: a -> a -> Bool
  ge: a -> a -> Bool
}
trait Display<a> {
  show: a -> Str
}
trait Arith<a> {
  add: a -> a -> a
  sub: a -> a -> a
  mul: a -> a -> a
  div: a -> a -> a
  rem: a -> a -> a
}
```

## Globals

These values are always in scope:

| Name | Type | Meaning |
|---|---|---|
| `self` | `Person` | the acting participant |
| `interested` | `List<Person>` | people who expressed interest |
| `committed` | `List<Person>` | people who committed (each carries a Dur) |
| `arrived` | `List<Person>` | people who have arrived |
| `lurkers` | `List<Person>` | passive observers |
| `today` | `Day` | current day of the week |
| `now` | `Time` | current wall-clock time |
| `min_people` | `Num` | minimum people to start |
| `max_people` | `Option<Num>` | optional cap on people |
| `group_size` | `Num` | target group size |
| `grouping_mode` | `Grouping` | single vs parallel groups |
| `duration` | `Dur` | activity duration |
| `max_commit` | `Dur` | maximum commit window |
| `groups_ready` | `Num` | number of ready groups |
| `waiting_count` | `Num` | people currently waiting |
| `spots_to_next` | `Num` | spots until the next group forms |
| `is_ready` | `Bool` | whether the room is ready |
| `ready_in` | `Option<Dur>` | time until the group is predicted to be ready (None if unknown) |
| `title` | `Str` | the activity's title |
| `code` | `Str` | the activity's room code |

## Standard library

Ready-made functions (written in the language itself):

- `len : List<a> -> Num` — Number of elements in a list.
- `sum : List<Num> -> Num` — Sum of a list of numbers.
- `avg : List<Num> -> Num` — Average of a list of numbers.
- `map : (a -> b) -> List<a> -> List<b>` — Apply a function to every element of a list.
- `head : List<a> -> Option<a>` — First element of a list, if present.
- `tail : List<a> -> List<a>` — All but the first element of a list (or [] for empty).
- `take : Num -> List<a> -> List<a>` — First n elements of a list.
- `drop : Num -> List<a> -> List<a>` — List without its first n elements.
- `foldl : (a -> b -> a) -> a -> List<b> -> a` — Left-associative fold over a list.
- `foldr : (a -> b -> b) -> b -> List<a> -> b` — Right-associative fold over a list.
- `filter : (a -> Bool) -> List<a> -> List<a>` — Keep only the elements for which the test is true.
- `sort : (a -> a -> Bool) -> List<a> -> List<a>` — Sort a list using a comparator (`sort compare xs`).
- `any : (a -> Bool) -> List<a> -> Bool` — True if the test holds for any element.
- `all : (a -> Bool) -> List<a> -> Bool` — True if the test holds for every element.
- `is_some : Option<a> -> Bool` — True if the option holds a value.
- `is_none : Option<a> -> Bool` — True if the option is empty.
- `unwrap_or : a -> Option<a> -> a` — The value inside an option, or a default when empty.
- `is_committed : Person -> Bool` — True if the person has committed.
- `is_arrived : Person -> Bool` — True if the person has arrived.
- `eta : Person -> Option<Dur>` — How long until the person is expected, if known.
- `waited : Person -> Dur` — How long the person has been engaged.
- `is_weekend : Day -> Bool` — True on Saturday or Sunday.

## Actions

An action is what a policy does. Think of it as something that may or may not
happen: when a policy decides to do nothing, its action is the empty action `{}`
(it "returns nothing").

- `notify "message"` — send a notification (supports `{interpolation}`).
- `commit` / `interest` / `lurk` — change your own state.
- `sleep 30s` — wait.
- `delay action 5m` — run an action after a delay.
- `action before target by lead` — schedule `action` to happen `lead` before an optional duration `target`.
- `{ a1, a2 }` — do several actions in order. `{}` does nothing.
- `if cond then action else action` — choose an action.

A policy is just an expression whose type is `Action`, so any of these forms can
be the whole policy:

```
commit                              (* always commit *)

#committed >= min_people => commit  (* commit only when enough people are in *)

match today with                    (* match must be exhaustive; `_` covers    *)
  | Sat -> lurk                      (*   the remaining days                    *)
  | Sun -> lurk
  | _ -> {}
```

### Notifying before an event

`ready_in : Option<Dur>` is the predicted time until the group is ready (or
`None` if it can't be predicted). You can write this directly as sugar:

```
notify "starting in 3 min!" before ready_in by 3min
```

It desugars to:

```
match ready_in with
  | Some(t) -> delay (notify "starting in 3 min!") (t - 3min)
  | None -> {}
```

`delay a d` waits `d` then runs `a`, so `delay (notify ...) (t - 3min)` fires the
notification 3 minutes before the group is ready. If `t - 3min` is negative it
fires immediately.

## Comments

`(* ... *)` is a comment (they can nest). `(** ... *)` documents the next definition.
