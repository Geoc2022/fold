//! Documentation generator. Renders a Markdown language reference from the
//! built-in type/trait declarations, globals, and the doc-comments (`(** *)`)
//! attached to the self-hosted prelude. The same text feeds `docs/language.md`
//! and the `/math` help panel.

use crate::ast::{Ty, TypeBody, TypeDecl};
use crate::prelude::PRELUDE_SRC;
use crate::typeck::{ty_to_string, TypeContext};
use crate::types::{builtin_traits, builtin_type_decls, global_docs, global_types};

/// Produce the full Markdown reference for the policy language.
pub fn language_docs() -> String {
    let ctx = TypeContext::default();
    let mut out = String::new();

    out.push_str("# Policy language\n\n");
    out.push_str("A small, strongly-typed language for writing room policies.\n");
    out.push_str("It's similar to ocaml with friendlier syntax\n\n");

    out.push_str("## Syntax Examples\n\n```\n");
    out.push_str(
        "count = #interested            (* a binding; # means \"how many\" *)\n\
double x = x * 2               (* a function of one argument *)\n\
add = fun a b -> a + b         (* the same, written with fun *)\n\
label = if count > 3 then \"many\" else \"few\"\n\
text = \"we have {count} people\"   (* string interpolation with { } *)\n\
first = match items with\n  | [] -> None\n  | x :: rest -> Some(x)\n\
count > min_people => notify \"ready! ({count})\"\n",
    );
    out.push_str("```\n\n");

    out.push_str("## Operators\n\n");
    out.push_str("| Operator | Meaning |\n|---|---|\n");
    for (op, meaning) in [
        ("`+ - * / %`", "arithmetic on `Num` (and `Dur`)"),
        ("`== !=`", "equality (any comparable type)"),
        ("`< > <= >=`", "ordering"),
        ("`and or not xor`", "boolean logic"),
        ("`::`", "prepend to a list"),
        ("`#xs`", "length of a list"),
        ("`xs[i]`", "list indexing (0-based)"),
        ("`.field` / `.0`", "record field / tuple element"),
    ] {
        out.push_str(&format!("| {op} | {meaning} |\n"));
    }
    out.push('\n');

    out.push_str("## Built-in types\n\n```\n");
    for decl in builtin_type_decls() {
        out.push_str(&render_type_decl(&decl));
        out.push('\n');
    }
    out.push_str("```\n\n");
    out.push_str(
        "Primitive types: `Num`, `Bool`, `Dur` (durations like `1h30m`), `Str`, `Time`. \
Plus `List<T>`, tuples `(A, B)`, functions `A -> B`, and `Action`.\n\n",
    );

    out.push_str("## Globals\n\n");
    out.push_str("These values are always in scope:\n\n| Name | Type | Meaning |\n|---|---|---|\n");
    let types: std::collections::HashMap<String, Ty> = global_types().into_iter().collect();
    for (name, meaning) in global_docs() {
        let ty = types
            .get(name)
            .map(ty_to_string)
            .unwrap_or_else(|| "?".to_string());
        out.push_str(&format!("| `{name}` | `{ty}` | {meaning} |\n"));
    }
    out.push('\n');

    out.push_str("## Standard library\n\n");
    out.push_str("Functions (written in the language itself):\n\n");
    for (name, doc) in prelude_entries() {
        let sig = ctx.describe(&name).unwrap_or_default();
        out.push_str(&format!("- `{name} : {sig}` — {doc}\n"));
    }
    out.push('\n');

    out.push_str("## Actions\n\n");
    out.push_str(
        "An action is what a policy does when its condition holds:\n\n\
- `notify \"message\"` — send a notification (supports `{interpolation}`).\n\
- `commit` / `interest` / `lurk` — change your own state.\n\
- `sleep 30s` — wait.\n\
- `delay action 5m` — run an action after a delay.\n\
- `{ a1, a2 }` — do several actions in order.\n\
- `if cond then action else action` — choose an action.\n\n",
    );

    out.push_str("## Comments\n\n");
    out.push_str(
        "`(* ... *)` is a comment (they can nest). `(** ... *)` documents the \
next definition.\n\n",
    );

    out.push_str("## Traits\n\n");
    out.push_str(
        "Traits are shared behaviours (type classes). Operators use the built-in ones; \
you can declare your own with `trait` and `impl`.\n\n```\n",
    );
    for t in builtin_traits() {
        out.push_str(&format!("trait {}<{}> {{\n", t.name, t.param));
        for (m, ty) in &t.methods {
            out.push_str(&format!("  {}: {}\n", m, ty_to_string(ty)));
        }
        out.push_str("}\n");
    }
    out.push_str("```\n\n");

    out
}

fn render_type_decl(decl: &TypeDecl) -> String {
    let params = if decl.params.is_empty() {
        String::new()
    } else {
        format!("<{}>", decl.params.join(", "))
    };
    match &decl.body {
        TypeBody::Record(fields) => {
            let fs: Vec<String> = fields
                .iter()
                .map(|(n, t)| format!("{n}: {}", ty_to_string(t)))
                .collect();
            format!("type {}{} = {{ {} }}", decl.name, params, fs.join(", "))
        }
        TypeBody::Variant(variants) => {
            let vs: Vec<String> = variants
                .iter()
                .map(|v| {
                    if v.args.is_empty() {
                        v.name.clone()
                    } else {
                        let args: Vec<String> = v.args.iter().map(ty_to_string).collect();
                        format!("{}({})", v.name, args.join(", "))
                    }
                })
                .collect();
            format!("type {}{} = {}", decl.name, params, vs.join(" | "))
        }
        TypeBody::Alias(ty) => format!("type {}{} = {}", decl.name, params, ty_to_string(ty)),
    }
}

/// `(name, doc)` for each documented prelude binding, in source order.
fn prelude_entries() -> Vec<(String, String)> {
    let src = format!("{PRELUDE_SRC}\ntrue => lurk\n");
    let mut out = Vec::new();
    if let Ok(program) = crate::parse::parse_program(&src) {
        for b in &program.bindings {
            if let crate::ast::Pattern::Var(name) = &b.pattern {
                if let Some(doc) = &b.doc {
                    out.push((name.clone(), doc.trim_start_matches('*').trim().to_string()));
                }
            }
        }
    }
    out
}
