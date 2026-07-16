//! Built-in types, traits, and globals for the policy language.
//!
//! Type-class ("trait") support follows the plan: built-in `Eq`/`Ord`/
//! `Display`/`Arith` plus user `trait`/`impl`, checked with a pragmatic
//! constraint solver and resolved at runtime by dispatching on the type tag of
//! the first argument (see `eval.rs`).

use crate::ast::{Ty, TypeBody, TypeDecl, VariantDef};

/// A type scheme: `forall vars. constraints => ty` (Damas–Milner + class
/// constraints).
#[derive(Debug, Clone)]
pub struct Scheme {
    pub vars: Vec<u32>,
    pub constraints: Vec<Constraint>,
    pub ty: Ty,
}

impl Scheme {
    pub fn mono(ty: Ty) -> Scheme {
        Scheme {
            vars: Vec::new(),
            constraints: Vec::new(),
            ty,
        }
    }
}

/// A single class constraint, e.g. `Ord a`.
#[derive(Debug, Clone, PartialEq)]
pub struct Constraint {
    pub trait_name: String,
    pub ty: Ty,
}

/// Static information about a trait (built-in or user-declared).
#[derive(Debug, Clone)]
pub struct TraitInfo {
    pub name: String,
    pub param: String,
    /// `(method name, method type using `param` as a type variable)`.
    pub methods: Vec<(String, Ty)>,
    pub superclasses: Vec<String>,
    pub builtin: bool,
    pub doc: Option<String>,
}

/// The built-in nominal types every policy sees.
pub fn builtin_type_decls() -> Vec<TypeDecl> {
    let tv = |s: &str| Ty::con(s); // lowercase => type variable
    vec![
        TypeDecl {
            doc: Some("A participant's lifecycle state.".to_string()),
            name: "State".to_string(),
            params: vec![],
            body: TypeBody::Variant(vec![
                VariantDef {
                    name: "Lurker".to_string(),
                    args: vec![],
                },
                VariantDef {
                    name: "Interested".to_string(),
                    args: vec![],
                },
                VariantDef {
                    name: "Committed".to_string(),
                    args: vec![Ty::dur()],
                },
                VariantDef {
                    name: "Arrived".to_string(),
                    args: vec![Ty::dur()],
                },
            ]),
        },
        TypeDecl {
            doc: Some("A person in the room.".to_string()),
            name: "Person".to_string(),
            params: vec![],
            body: TypeBody::Record(vec![
                ("name".to_string(), Ty::str()),
                ("state".to_string(), Ty::con("State")),
            ]),
        },
        TypeDecl {
            doc: Some("An optional value: either `None` or `Some(x)`.".to_string()),
            name: "Option".to_string(),
            params: vec!["a".to_string()],
            body: TypeBody::Variant(vec![
                VariantDef {
                    name: "None".to_string(),
                    args: vec![],
                },
                VariantDef {
                    name: "Some".to_string(),
                    args: vec![tv("a")],
                },
            ]),
        },
        TypeDecl {
            doc: Some("A day of the week.".to_string()),
            name: "Day".to_string(),
            params: vec![],
            body: TypeBody::Variant(
                ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                    .iter()
                    .map(|d| VariantDef {
                        name: d.to_string(),
                        args: vec![],
                    })
                    .collect(),
            ),
        },
        TypeDecl {
            doc: Some("How groups are formed.".to_string()),
            name: "Grouping".to_string(),
            params: vec![],
            body: TypeBody::Variant(vec![
                VariantDef {
                    name: "Single".to_string(),
                    args: vec![],
                },
                VariantDef {
                    name: "Parallel".to_string(),
                    args: vec![],
                },
            ]),
        },
        TypeDecl {
            doc: Some("A wall-clock time.".to_string()),
            name: "Time".to_string(),
            params: vec![],
            body: TypeBody::Record(vec![
                ("hour".to_string(), Ty::num()),
                ("minute".to_string(), Ty::num()),
            ]),
        },
    ]
}

/// Built-in traits with primitive impls.
pub fn builtin_traits() -> Vec<TraitInfo> {
    let a = || Ty::con("a");
    vec![
        TraitInfo {
            name: "Eq".to_string(),
            param: "a".to_string(),
            methods: vec![("eq".to_string(), Ty::arrow(&[a(), a()], Ty::bool()))],
            superclasses: vec![],
            builtin: true,
            doc: Some("Types whose values can be compared for equality.".to_string()),
        },
        TraitInfo {
            name: "Ord".to_string(),
            param: "a".to_string(),
            methods: vec![
                ("lt".to_string(), Ty::arrow(&[a(), a()], Ty::bool())),
                ("le".to_string(), Ty::arrow(&[a(), a()], Ty::bool())),
                ("gt".to_string(), Ty::arrow(&[a(), a()], Ty::bool())),
                ("ge".to_string(), Ty::arrow(&[a(), a()], Ty::bool())),
            ],
            superclasses: vec!["Eq".to_string()],
            builtin: true,
            doc: Some("Types with a total order.".to_string()),
        },
        TraitInfo {
            name: "Display".to_string(),
            param: "a".to_string(),
            methods: vec![("show".to_string(), Ty::arrow(&[a()], Ty::str()))],
            superclasses: vec![],
            builtin: true,
            doc: Some(
                "Types that can be rendered as text (used in string interpolation).".to_string(),
            ),
        },
        TraitInfo {
            name: "Arith".to_string(),
            param: "a".to_string(),
            methods: vec![
                ("add".to_string(), Ty::arrow(&[a(), a()], a())),
                ("sub".to_string(), Ty::arrow(&[a(), a()], a())),
                ("mul".to_string(), Ty::arrow(&[a(), a()], a())),
                ("div".to_string(), Ty::arrow(&[a(), a()], a())),
                ("rem".to_string(), Ty::arrow(&[a(), a()], a())),
            ],
            superclasses: vec![],
            builtin: true,
            doc: Some("Types supporting arithmetic (`+ - * / %`).".to_string()),
        },
    ]
}

/// The type head name of a `Ty` for impl resolution (e.g. `List`, `Num`,
/// `Option`, `Tuple`, `Fun`).
pub fn ty_head(ty: &Ty) -> Option<String> {
    match ty {
        Ty::Con(name, _) => Some(name.clone()),
        Ty::Tuple(_) => Some("Tuple".to_string()),
        Ty::Fun(_, _) => Some("Fun".to_string()),
        Ty::Var(_) => None,
    }
}

/// Whether a built-in trait is satisfied by a concrete type head.
/// `None` means "cannot decide yet" (type variable / structural recursion).
pub fn builtin_impl_holds(trait_name: &str, ty: &Ty) -> Option<bool> {
    let head = ty_head(ty)?;
    let ok = match trait_name {
        // Equality and display are structural for everything except functions.
        "Eq" | "Display" => head != "Fun",
        "Ord" => matches!(
            head.as_str(),
            "Num" | "Dur" | "Str" | "Day" | "Time" | "List" | "Tuple"
        ),
        "Arith" => matches!(head.as_str(), "Num" | "Dur"),
        _ => return None,
    };
    Some(ok)
}

/// The globals available to every policy: `(name, type)`.
pub fn global_types() -> Vec<(String, Ty)> {
    let person = || Ty::con("Person");
    let people = || Ty::list(person());
    vec![
        ("self".to_string(), person()),
        ("interested".to_string(), people()),
        ("committed".to_string(), people()),
        ("arrived".to_string(), people()),
        ("lurkers".to_string(), people()),
        ("today".to_string(), Ty::con("Day")),
        ("now".to_string(), Ty::con("Time")),
        ("min_people".to_string(), Ty::num()),
        (
            "max_people".to_string(),
            Ty::Con("Option".to_string(), vec![Ty::num()]),
        ),
        ("group_size".to_string(), Ty::num()),
        ("grouping_mode".to_string(), Ty::con("Grouping")),
        ("duration".to_string(), Ty::dur()),
        ("max_commit".to_string(), Ty::dur()),
        ("groups_ready".to_string(), Ty::num()),
        ("waiting_count".to_string(), Ty::num()),
        ("spots_to_next".to_string(), Ty::num()),
        ("is_ready".to_string(), Ty::bool()),
        (
            "ready_in".to_string(),
            Ty::Con("Option".to_string(), vec![Ty::dur()]),
        ),
        ("title".to_string(), Ty::str()),
        ("code".to_string(), Ty::str()),
    ]
}

/// Documentation for each global (name, description) for the help panel.
pub fn global_docs() -> Vec<(&'static str, &'static str)> {
    vec![
        ("self", "the acting participant"),
        ("interested", "people who expressed interest"),
        ("committed", "people who committed (each carries a Dur)"),
        ("arrived", "people who have arrived"),
        ("lurkers", "passive observers"),
        ("today", "current day of the week"),
        ("now", "current wall-clock time"),
        ("min_people", "minimum people to start"),
        ("max_people", "optional cap on people"),
        ("group_size", "target group size"),
        ("grouping_mode", "single vs parallel groups"),
        ("duration", "activity duration"),
        ("max_commit", "maximum commit window"),
        ("groups_ready", "number of ready groups"),
        ("waiting_count", "people currently waiting"),
        ("spots_to_next", "spots until the next group forms"),
        ("is_ready", "whether the room is ready"),
        (
            "ready_in",
            "time until the group is predicted to be ready (None if unknown)",
        ),
        ("title", "the activity's title"),
        ("code", "the activity's room code"),
    ]
}
