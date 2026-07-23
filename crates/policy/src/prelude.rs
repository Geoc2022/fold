//! The self-hosted prelude: standard-library functions written in the policy
//! language itself (recursion + list patterns). It is parsed and type-checked
//! when the [`crate::typeck::TypeContext`] is built, and its definitions are
//! made available to every policy and REPL expression.
//!
//! Evaluation is bounded by a step limit (see `eval.rs`) so recursion cannot
//! hang the playground.

pub const PRELUDE_SRC: &str = r#"
(** Number of elements in a list. *)
len xs = match xs with
  | [] -> 0
  | _ :: rest -> 1 + len rest

(** Sum of a list of numbers. *)
sum xs = match xs with
  | [] -> 0
  | x :: rest -> x + sum rest

(** Average of a list of numbers. *)
avg xs = sum xs / len xs

(** Apply a function to every element of a list. *)
map f xs = match xs with
  | [] -> []
  | x :: rest -> f x :: map f rest

(** First element of a list, if present. *)
head xs = match xs with
  | [] -> None
  | x :: _ -> Some(x)

(** All but the first element of a list (or [] for empty). *)
tail xs = match xs with
  | [] -> []
  | _ :: rest -> rest

(** First n elements of a list. *)
take n xs = if n <= 0 then [] else match xs with
  | [] -> []
  | x :: rest -> x :: take (n - 1) rest

(** List without its first n elements. *)
drop n xs = if n <= 0 then xs else match xs with
  | [] -> []
  | _ :: rest -> drop (n - 1) rest

(** Left-associative fold over a list. *)
foldl f acc xs = match xs with
  | [] -> acc
  | x :: rest -> foldl f (f acc x) rest

(** Right-associative fold over a list. *)
foldr f acc xs = match xs with
  | [] -> acc
  | x :: rest -> f x (foldr f acc rest)

(** Keep only the elements for which the test is true. *)
filter test xs = match xs with
  | [] -> []
  | x :: rest -> if test x then x :: filter test rest else filter test rest

(** Insert one value into an already-sorted list using a comparator. *)
insert_sorted compare x xs = match xs with
  | [] -> [x]
  | y :: rest -> if compare x y then x :: xs else y :: insert_sorted compare x rest

(** Sort a list using a comparator (like OCaml's sort compare xs). *)
sort compare xs = match xs with
  | [] -> []
  | x :: rest -> insert_sorted compare x (sort compare rest)

(** True if the test holds for any element. *)
any test xs = match xs with
  | [] -> false
  | x :: rest -> if test x then true else any test rest

(** True if the test holds for every element. *)
all test xs = match xs with
  | [] -> true
  | x :: rest -> if test x then all test rest else false

(** True if the option holds a value. *)
is_some o = match o with
  | Some(_) -> true
  | None -> false

(** True if the option is empty. *)
is_none o = match o with
  | None -> true
  | Some(_) -> false

(** The value inside an option, or a default when empty. *)
unwrap_or fallback o = match o with
  | Some(x) -> x
  | None -> fallback

(** True if the person has committed. *)
is_committed p = match p.state with
  | Committed(_) -> true
  | _ -> false

(** True if the person has arrived. *)
is_arrived p = match p.state with
  | Arrived(_) -> true
  | _ -> false

(** How long until the person is expected, if known. *)
eta p = match p.state with
  | Committed(d) -> Some(d)
  | Arrived(d) -> Some(d)
  | _ -> None

(** How long the person has been engaged. *)
waited p = p.engaged_for

(** True on Saturday or Sunday. *)
is_weekend d = match d with
  | Sat -> true
  | Sun -> true
  | _ -> false
"#;
