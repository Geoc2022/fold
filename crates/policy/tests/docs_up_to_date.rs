use std::env;
use std::fs;
use std::path::PathBuf;

#[test]
fn docs_up_to_date() {
    let generated = policy::language_docs();
    let docs_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("language.md");

    if env::var("REGEN_DOCS").ok().as_deref() == Some("1") {
        fs::write(&docs_path, generated).expect("write docs/language.md");
        return;
    }

    let existing = fs::read_to_string(&docs_path).expect("read docs/language.md");
    assert_eq!(
        existing, generated,
        "docs/language.md is out of date. Run: REGEN_DOCS=1 cargo test -p policy docs_up_to_date",
    );
}
