//! Documentation generator. Renders a Markdown language reference from the
//! built-in type/trait declarations, globals, and the doc-comments (`(** *)`)
//! attached to the self-hosted prelude.

use crate::ast::{Ty, TypeBody, TypeDecl};
use crate::prelude::PRELUDE_SRC;
use crate::typeck::{ty_to_string, TypeContext};
use crate::types::{builtin_traits, builtin_type_decls, global_docs, global_types};

const REPO_BLOB: &str = "https://github.com/Geoc2022/fold/blob/main";

/// Produce the full Markdown reference for the policy language.
pub fn language_docs() -> String {
    let ctx = TypeContext::default();
    let mut out = String::new();

    out.push_str("# Policy language\n\n");
    out.push_str("A small, strongly-typed language for writing room notification policies.\n\n");
    out.push_str("It reads like a simplified OCaml. ");
    out.push_str("However, newlines separate statements and there are no semicolons.\n");
    out.push_str("A policy is a program whose final expression is an `Action`.\n\n");

    out.push_str("## Syntax at a glance\n\n```\n");
    out.push_str(
        "count = #interested\n\
double x = x * 2\n\
add = fun a b -> a + b\n\
label = if count > 3 then \"many\" else \"few\"\n\
text = \"we have {count} people\"\n\
first = match interested with\n  | [] -> None\n  | x :: rest -> Some(x)\n\
count > min_people => notify \"ready! ({count})\"\n",
    );
    out.push_str("```\n\n");

    out.push_str("## Bindings and functions\n\n");
    out.push_str("- `name = expr` binds a value.\n");
    out.push_str("- `name a b = expr` is function sugar for nested lambdas.\n");
    out.push_str("- `fun a b -> expr` is an explicit lambda.\n");
    out.push_str("- Destructuring is allowed in bindings: `{x, y} = rec`, `(a, b) = pair`.\n\n");

    out.push_str("## Operators\n\n");
    out.push_str("| Operator | Meaning |\n|---|---|\n");
    for (op, meaning) in [
        (
            "`+ - * / %`",
            "arithmetic on `Num` (and `Dur` where supported)",
        ),
        ("`== !=`", "equality (for `Eq` types)"),
        ("`< > <= >=`", "ordering (for `Ord` types)"),
        ("`and or not xor`", "boolean logic"),
        ("`::`", "prepend to a list"),
        ("`#xs`", "length sugar (`len xs`)"),
        ("`xs[i]`", "list indexing (0-based)"),
        ("`.field` / `.0`", "record field / tuple element"),
    ] {
        out.push_str(&format!("| {op} | {meaning} |\n"));
    }
    out.push('\n');

    out.push_str("## Strings\n\n");
    out.push_str("- Interpolation uses `{expr}`: `\"hi {self.name}\"`.\n");
    out.push_str("- Escape literal braces with `{{` and `}}`.\n");
    out.push_str("- Standard escapes: `\\n`, `\\t`, `\\\"`, `\\\\`.\n\n");

    out.push_str("## Control flow and patterns\n\n");
    out.push_str("- `if cond then a else b`\n");
    out.push_str("- `match expr with | pat -> expr ...` (must be exhaustive)\n");
    out.push_str("- Patterns: literals, variants (`Some(x)`), tuples, lists (`[a, b]`), cons (`x :: xs`), records (`{field, _}`), wildcard (`_`).\n\n");

    out.push_str("## Built-in types\n\n```\n");
    for decl in builtin_type_decls() {
        out.push_str(&render_type_decl(&decl));
        out.push('\n');
    }
    out.push_str("```\n\n");
    out.push_str(
        "Primitive types: `Num`, `Bool`, `Dur` (durations like `1h30m`), `Str`, `Time`.\n\
Plus collections/functions: `List<T>`, tuples `(A, B)`, and functions `A -> B`.\n\n",
    );

    out.push_str("## Type and trait declarations\n\n");
    out.push_str("- Define custom types with `type` (record, variant, or alias).\n");
    out.push_str("- Define traits with `trait Name<a> { ... }` and instances with `impl Name<MyType> { ... }`.\n");
    out.push_str("- Built-ins use traits too (for operators and interpolation).\n\n");

    out.push_str("### Built-in traits\n\n```\n");
    for t in builtin_traits() {
        out.push_str(&format!("trait {}<{}> {{\n", t.name, t.param));
        for (m, ty) in &t.methods {
            out.push_str(&format!("  {}: {}\n", m, ty_to_string(ty)));
        }
        out.push_str("}\n\n");
    }
    out.push_str("```\n\n");

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
    out.push_str(&format!(
        "Source: [`crates/policy/src/prelude.rs`]({})\n\n",
        blob("crates/policy/src/prelude.rs")
    ));
    out.push_str("| Function | Signature | Description |\n|---|---|---|\n");
    for (name, doc) in prelude_entries() {
        let sig = ctx.describe(&name).unwrap_or_else(|| "?".to_string());
        out.push_str(&format!(
            "| `{name}` | `{sig}` | {} |\n",
            escape_table_cell(&doc)
        ));
    }
    out.push('\n');

    out.push_str("## Actions\n\n");
    out.push_str("An action is what a policy does when it fires.\n\n");
    out.push_str("- `notify \"message\"` — send a notification (supports `{interpolation}`).\n");
    out.push_str("- `commit` / `interest` / `lurk` — change your own state.\n");
    out.push_str("- `commit +3m` / `commit -3m` — adjust commit ETA.\n");
    out.push_str("- `sleep 30s` — wait.\n");
    out.push_str("- `delay action 5m` — run an action after a delay.\n");
    out.push_str("- `action before target by lead` — schedule `action` to happen `lead` before an optional duration `target`.\n");
    out.push_str("- `{ a1, a2 }` — run actions in order. `{}` is no-op.\n\n");

    out.push_str("## Desugaring\n\n");
    out.push_str("Language sugar is expanded before typechecking/evaluation:\n\n");
    out.push_str("- `condition => action`\n");
    out.push_str("  becomes `if condition then action else {}`.\n");
    out.push_str("- `#xs`\n");
    out.push_str("  becomes `len xs`.\n");
    out.push_str("- `notify \"starting\" before ready_in by 3min`\n");
    out.push_str("  becomes:\n\n```\n");
    out.push_str("match ready_in with\n  | Some(t) -> delay (notify \"starting\") (t - 3min)\n  | None -> {}\n");
    out.push_str("```\n\n");
    out.push_str("- `f a b = expr`\n");
    out.push_str("  becomes `f = fun a b -> expr`.\n\n");

    out.push_str("## Comments\n\n");
    out.push_str(
        "- `(* ... *)` comments can nest.\n\
- `(** ... *)` documents the next definition (used by prelude docs).\n\n",
    );

    out.push_str("## Evaluation model\n\n");
    out.push_str("Policies are re-evaluated as room state changes and polling ticks.\n");
    out.push_str("`now`/`today` reflect current wall-clock context from the host app.\n");
    out.push_str("Evaluation is step-bounded, so recursive helpers cannot run forever.\n\n");

    out.push_str("## Examples\n\n");
    out.push_str(&format!(
        "For examples and ready-to-copy templates, see [`docs/policy-examples.md`]({}).\n",
        blob("docs/policy-examples.md")
    ));

    out
}

fn blob(path: &str) -> String {
    format!("{REPO_BLOB}/{path}")
}

fn escape_table_cell(src: &str) -> String {
    src.replace('|', "\\|")
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
