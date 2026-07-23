# Policy language

A small, strongly-typed language for writing room notification policies.

It reads like a simplified OCaml. However, newlines separate statements and there are no semicolons.
A policy is a program whose final expression is an `Action`.

## Examples

For examples and ready-to-copy templates, see [`docs/policy-examples.md`](https://github.com/Geoc2022/fold/blob/main/docs/policy-examples.md).

## Bindings and functions

- `name = expr` binds a value.
- `name a b = expr` is function sugar for nested lambdas.
- `fun a b -> expr` is an explicit lambda.
- Destructuring is allowed in bindings: `{x, y} = rec`, `(a, b) = pair`.

## Operators

| Operator | Meaning |
|---|---|
| `+ - * / %` | arithmetic on `Num` (and `Dur` where supported) |
| `== !=` | equality (for `Eq` types) |
| `< > <= >=` | ordering (for `Ord` types) |
| `and or not xor` | boolean logic |
| `::` | prepend to a list |
| `#xs` | length sugar (`len xs`) |
| `xs[i]` | list indexing (0-based) |
| `.field` / `.0` | record field / tuple element |

## Strings

- Interpolation uses `{expr}`: `"hi {self.name}"`.
- Escape literal braces with `{{` and `}}`.
- Standard escapes: `\n`, `\t`, `\"`, `\\`.

## Control flow and patterns

- `if cond then a else b`
- `match expr with | pat -> expr ...` (must be exhaustive)
- Patterns: literals, variants (`Some(x)`), tuples, lists (`[a, b]`), cons (`x :: xs`), records (`{field, _}`), wildcard (`_`).

## Built-in types

```
type State = Lurker | Interested | Committed(Dur) | Arrived(Dur)
type Person = { name: Str, state: State, engaged_for: Dur }
type Option<a> = None | Some(a)
type Day = Mon | Tue | Wed | Thu | Fri | Sat | Sun
type Grouping = Single | Parallel
type Time = { hour: Num, minute: Num }
```

Primitive types: `Num`, `Bool`, `Dur` (durations like `1h30m`), `Str`, `Time`.
Plus collections/functions: `List<T>`, tuples `(A, B)`, and functions `A -> B`.

## Type and trait declarations

- Define custom types with `type` (record, variant, or alias).
- Define traits with `trait Name<a> { ... }` and instances with `impl Name<MyType> { ... }`.
- Built-ins use traits too (for operators and interpolation).

### Built-in traits

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

Source: [`crates/policy/src/prelude.rs`](https://github.com/Geoc2022/fold/blob/main/crates/policy/src/prelude.rs)

| Function | Signature | Description |
|---|---|---|
| `len` | `List<a> -> Num` | Number of elements in a list. |
| `sum` | `List<Num> -> Num` | Sum of a list of numbers. |
| `avg` | `List<Num> -> Num` | Average of a list of numbers. |
| `map` | `(a -> b) -> List<a> -> List<b>` | Apply a function to every element of a list. |
| `head` | `List<a> -> Option<a>` | First element of a list, if present. |
| `tail` | `List<a> -> List<a>` | All but the first element of a list (or [] for empty). |
| `take` | `Num -> List<a> -> List<a>` | First n elements of a list. |
| `drop` | `Num -> List<a> -> List<a>` | List without its first n elements. |
| `foldl` | `(a -> b -> a) -> a -> List<b> -> a` | Left-associative fold over a list. |
| `foldr` | `(a -> b -> b) -> b -> List<a> -> b` | Right-associative fold over a list. |
| `filter` | `(a -> Bool) -> List<a> -> List<a>` | Keep only the elements for which the test is true. |
| `insert_sorted` | `(a -> a -> Bool) -> a -> List<a> -> List<a>` | Insert one value into an already-sorted list using a comparator. |
| `sort` | `(a -> a -> Bool) -> List<a> -> List<a>` | Sort a list using a comparator (like OCaml's sort compare xs). |
| `any` | `(a -> Bool) -> List<a> -> Bool` | True if the test holds for any element. |
| `all` | `(a -> Bool) -> List<a> -> Bool` | True if the test holds for every element. |
| `is_some` | `Option<a> -> Bool` | True if the option holds a value. |
| `is_none` | `Option<a> -> Bool` | True if the option is empty. |
| `unwrap_or` | `a -> Option<a> -> a` | The value inside an option, or a default when empty. |
| `is_committed` | `Person -> Bool` | True if the person has committed. |
| `is_arrived` | `Person -> Bool` | True if the person has arrived. |
| `eta` | `Person -> Option<Dur>` | How long until the person is expected, if known. |
| `waited` | `Person -> Dur` | How long the person has been engaged. |
| `is_weekend` | `Day -> Bool` | True on Saturday or Sunday. |

## Actions

An action is what a policy does when it fires.

- `notify "message"` — send a notification (supports `{interpolation}`).
- `commit` / `interest` / `lurk` — change your own state.
- `commit +3m` / `commit -3m` — adjust commit ETA.
- `sleep 30s` — wait.
- `delay action 5m` — run an action after a delay.
- `action before target by lead` — schedule `action` to happen `lead` before an optional duration `target`.
- `{ a1, a2 }` — run actions in order. `{}` is no-op.

## Desugaring

Language sugar is expanded before typechecking/evaluation:

- `condition => action`
  becomes `if condition then action else {}`.
- `#xs`
  becomes `len xs`.
- `notify "starting" before ready_in by 3min`
  becomes:

```
match ready_in with
  | Some(t) -> delay (notify "starting") (t - 3min)
  | None -> {}
```

- `f a b = expr`
  becomes `f = fun a b -> expr`.

## Comments

- `(* ... *)` comments can nest.
- `(** ... *)` documents the next definition (used by prelude docs).

## Evaluation model

Policies are re-evaluated as room state changes and polling ticks.
`now`/`today` reflect current wall-clock context from the host app.
Evaluation is step-bounded, so recursive helpers cannot run forever.
