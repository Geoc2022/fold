use std::fs;
use std::path::PathBuf;

fn policy_blocks_from_markdown(markdown: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut in_policy_block = false;
    let mut current = String::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if !in_policy_block {
            if trimmed == "```policy" {
                in_policy_block = true;
                current.clear();
            }
            continue;
        }

        if trimmed == "```" {
            blocks.push(current.trim_end().to_string());
            in_policy_block = false;
            current.clear();
            continue;
        }

        current.push_str(line);
        current.push('\n');
    }

    blocks
}

#[test]
fn policy_examples_in_docs_typecheck() {
    let docs_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("policy-examples.md");

    let markdown = fs::read_to_string(&docs_path).expect("read docs/policy-examples.md");
    let examples = policy_blocks_from_markdown(&markdown);
    assert!(!examples.is_empty(), "no ```policy blocks found in docs/policy-examples.md");

    for (idx, src) in examples.iter().enumerate() {
        let compiled = policy::compile_policy_with_diagnostics(src);
        assert!(
            compiled.diagnostics.is_empty(),
            "example #{} failed:\n{}\n\nfirst diagnostic: {}",
            idx + 1,
            src,
            compiled
                .diagnostics
                .first()
                .map(|d| d.message.as_str())
                .unwrap_or("<none>")
        );
    }
}
