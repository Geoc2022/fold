//! Persistence and API shapes for personal policy sets.
//!
//! A `policy_sets` row is meaningful even when it has no `policy_rules`: an
//! empty room set explicitly disables inherited home rules.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
};

use policy::{
    ast::{Decl, Expr, StrSeg, TypedProgram},
    diag::Diagnostic,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::{wasm_bindgen::JsValue, D1Database};

pub const MAX_RULES: usize = 20;
pub const MAX_SOURCE_BYTES: usize = 16 * 1024;

pub type PolicyStoreResult<T> = std::result::Result<T, PolicyStoreError>;
type StoreResult<T> = PolicyStoreResult<T>;

#[derive(Debug)]
pub enum PolicyStoreError {
    InvalidRequest(String),
    Compile {
        rule_index: usize,
        diagnostics: Vec<Diagnostic>,
    },
    Conflict {
        expected_revision: i64,
        actual_revision: Option<i64>,
    },
    Database(worker::Error),
    CorruptData(String),
}

impl PolicyStoreError {
    /// Suggested HTTP status for an API adapter.
    pub fn status_code(&self) -> u16 {
        match self {
            Self::InvalidRequest(_) | Self::Compile { .. } => 400,
            Self::Conflict { .. } => 409,
            Self::Database(_) | Self::CorruptData(_) => 500,
        }
    }
}

impl fmt::Display for PolicyStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(f, "invalid policy set: {message}"),
            Self::Compile {
                rule_index,
                diagnostics,
            } => {
                let message = diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.as_str())
                    .unwrap_or("policy compilation failed");
                write!(f, "rule {rule_index} did not compile: {message}")
            }
            Self::Conflict {
                expected_revision,
                actual_revision: Some(actual_revision),
            } => write!(
                f,
                "policy set revision conflict: expected {expected_revision}, current revision is {actual_revision}"
            ),
            Self::Conflict {
                expected_revision,
                actual_revision: None,
            } => write!(
                f,
                "policy set revision conflict: expected {expected_revision}, but the set does not exist"
            ),
            Self::Database(error) => write!(f, "policy database error: {error}"),
            Self::CorruptData(message) => write!(f, "invalid stored policy data: {message}"),
        }
    }
}

impl Error for PolicyStoreError {}

impl From<worker::Error> for PolicyStoreError {
    fn from(error: worker::Error) -> Self {
        Self::Database(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyScope {
    Home,
    Room,
}

impl PolicyScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Room => "room",
        }
    }

    fn parse(value: &str) -> StoreResult<Self> {
        match value {
            "home" => Ok(Self::Home),
            "room" => Ok(Self::Room),
            other => Err(PolicyStoreError::CorruptData(format!(
                "unknown scope '{other}'"
            ))),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReplacePolicySetRequest {
    pub scope: PolicyScope,
    #[serde(default)]
    pub activity_id: Option<String>,
    pub timezone: String,
    /// The current revision. Use zero when creating a set.
    pub revision: i64,
    pub rules: Vec<PolicyRuleRequest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyRuleRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub source: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRuleResponse {
    pub id: String,
    pub position: i64,
    pub source: String,
    pub source_hash: String,
    pub time_dependent: bool,
    pub enabled: bool,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicySetResponse {
    pub id: String,
    pub scope: PolicyScope,
    pub activity_id: Option<String>,
    pub timezone: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub rules: Vec<PolicyRuleResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicySetsResponse {
    pub sets: Vec<PolicySetResponse>,
}

#[derive(Debug, Clone)]
pub struct EffectivePolicyRule {
    pub id: String,
    pub compiled: TypedProgram,
    pub time_dependent: bool,
    pub enabled: bool,
    pub version: i64,
}

#[derive(Debug, Clone)]
pub struct EffectivePolicySet {
    pub id: String,
    pub scope: PolicyScope,
    pub timezone: String,
    pub rules: Vec<EffectivePolicyRule>,
}

#[derive(Debug, Clone, Deserialize)]
struct PolicySetRow {
    id: String,
    scope: String,
    activity_id: Option<String>,
    revision: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct JoinedRow {
    set_id: String,
    scope: String,
    activity_id: Option<String>,
    timezone: String,
    revision: i64,
    set_created_at: i64,
    set_updated_at: i64,
    rule_id: Option<String>,
    position: Option<i64>,
    source: Option<String>,
    compiled_json: Option<String>,
    source_hash: Option<String>,
    time_dependent: Option<i64>,
    enabled: Option<i64>,
    version: Option<i64>,
    rule_created_at: Option<i64>,
    rule_updated_at: Option<i64>,
}

#[derive(Debug)]
struct CompiledRule {
    id: String,
    position: i64,
    source: String,
    compiled_json: String,
    source_hash: String,
    time_dependent: bool,
    enabled: bool,
    version: i64,
    existing: bool,
    created_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ExistingRuleRow {
    id: String,
    source_hash: String,
    version: i64,
    created_at: i64,
}

const JOINED_COLUMNS: &str = "\
    ps.id AS set_id, ps.scope, ps.activity_id, ps.timezone, ps.revision, \
    ps.created_at AS set_created_at, ps.updated_at AS set_updated_at, \
    pr.id AS rule_id, pr.position, pr.source, pr.compiled_json, pr.source_hash, \
    pr.time_dependent, pr.enabled, pr.version, \
    pr.created_at AS rule_created_at, pr.updated_at AS rule_updated_at";

/// Load the room set when one exists, otherwise the person's home set.
///
/// The chosen set is returned even when `rules` is empty, preserving an
/// explicit empty room override.
pub async fn load_effective_policy_set(
    db: &D1Database,
    person_id: &str,
    activity_id: &str,
) -> PolicyStoreResult<Option<EffectivePolicySet>> {
    let sql = format!(
        "WITH effective AS (\
           SELECT * FROM policy_sets \
           WHERE person_id = ?1 \
             AND (scope = 'home' OR (scope = 'room' AND activity_id = ?2)) \
           ORDER BY CASE scope WHEN 'room' THEN 0 ELSE 1 END \
           LIMIT 1\
         ) \
         SELECT {JOINED_COLUMNS} \
         FROM effective ps \
         LEFT JOIN policy_rules pr ON pr.policy_set_id = ps.id \
         ORDER BY pr.position"
    );
    let rows = db
        .prepare(sql)
        .bind(&[s(person_id), s(activity_id)])?
        .all()
        .await?
        .results::<JoinedRow>()?;
    effective_from_rows(rows)
}

/// Return explicit sets for API use. With an activity id this returns only the
/// home set and that room's override; without one it returns all of the
/// person's sets.
pub async fn get_policy_sets_for_api(
    db: &D1Database,
    person_id: &str,
    activity_id: Option<&str>,
) -> PolicyStoreResult<PolicySetsResponse> {
    let (where_clause, values) = match activity_id {
        Some(activity_id) => (
            "ps.person_id = ?1 AND (ps.scope = 'home' OR ps.activity_id = ?2)",
            vec![s(person_id), s(activity_id)],
        ),
        None => ("ps.person_id = ?1", vec![s(person_id)]),
    };
    let sql = format!(
        "SELECT {JOINED_COLUMNS} \
         FROM policy_sets ps \
         LEFT JOIN policy_rules pr ON pr.policy_set_id = ps.id \
         WHERE {where_clause} \
         ORDER BY CASE ps.scope WHEN 'home' THEN 0 ELSE 1 END, \
                  ps.activity_id, pr.position"
    );
    let rows = db
        .prepare(sql)
        .bind(&values)?
        .all()
        .await?
        .results::<JoinedRow>()?;
    Ok(PolicySetsResponse {
        sets: responses_from_rows(rows)?,
    })
}

/// Compile and transactionally replace a complete policy set.
///
/// Revision zero creates a missing set. Existing sets require their exact
/// current revision. D1 executes `batch` transactionally; every rule mutation
/// is additionally guarded by the revision established by the first statement.
pub async fn replace_policy_set(
    db: &D1Database,
    person_id: &str,
    mut request: ReplacePolicySetRequest,
    now: i64,
) -> PolicyStoreResult<PolicySetResponse> {
    validate_request(&request)?;
    let current = find_set(db, person_id, request.scope, request.activity_id.as_deref()).await?;
    let existing_rules = match &current {
        Some(current) => load_existing_rules(db, &current.id).await?,
        None => HashMap::new(),
    };
    let compiled_rules = compile_rules(std::mem::take(&mut request.rules), &existing_rules)?;

    match current {
        Some(current) => {
            if current.revision != request.revision {
                return Err(PolicyStoreError::Conflict {
                    expected_revision: request.revision,
                    actual_revision: Some(current.revision),
                });
            }
            replace_existing(
                db,
                person_id,
                current,
                request.timezone,
                compiled_rules,
                now,
            )
            .await
        }
        None if request.revision == 0 => {
            create_set(db, person_id, request, compiled_rules, now).await
        }
        None => Err(PolicyStoreError::Conflict {
            expected_revision: request.revision,
            actual_revision: None,
        }),
    }
}

fn validate_request(request: &ReplacePolicySetRequest) -> StoreResult<()> {
    if request.revision < 0 {
        return Err(PolicyStoreError::InvalidRequest(
            "revision cannot be negative".to_string(),
        ));
    }
    if request.rules.len() > MAX_RULES {
        return Err(PolicyStoreError::InvalidRequest(format!(
            "at most {MAX_RULES} rules are allowed"
        )));
    }
    if request.timezone.trim().is_empty() {
        return Err(PolicyStoreError::InvalidRequest(
            "timezone cannot be empty".to_string(),
        ));
    }
    match (request.scope, request.activity_id.as_deref()) {
        (PolicyScope::Home, None) => {}
        (PolicyScope::Home, Some(_)) => {
            return Err(PolicyStoreError::InvalidRequest(
                "a home set cannot have an activity_id".to_string(),
            ));
        }
        (PolicyScope::Room, Some(activity_id)) if !activity_id.trim().is_empty() => {}
        (PolicyScope::Room, _) => {
            return Err(PolicyStoreError::InvalidRequest(
                "a room set requires an activity_id".to_string(),
            ));
        }
    }
    let mut ids = HashSet::new();
    for (index, rule) in request.rules.iter().enumerate() {
        if rule.id.as_ref().is_some_and(|id| !ids.insert(id.as_str())) {
            return Err(PolicyStoreError::InvalidRequest(format!(
                "rule {index} repeats an id"
            )));
        }
        let len = rule.source.len();
        if len > MAX_SOURCE_BYTES {
            return Err(PolicyStoreError::InvalidRequest(format!(
                "rule {index} source is {len} bytes; maximum is {MAX_SOURCE_BYTES}"
            )));
        }
    }
    Ok(())
}

fn compile_rules(
    rules: Vec<PolicyRuleRequest>,
    existing: &HashMap<String, ExistingRuleRow>,
) -> StoreResult<Vec<CompiledRule>> {
    rules
        .into_iter()
        .enumerate()
        .map(|(index, rule)| {
            let compiled = policy::compile_policy(&rule.source).map_err(|diagnostics| {
                PolicyStoreError::Compile {
                    rule_index: index,
                    diagnostics,
                }
            })?;
            let compiled_json = serde_json::to_string(&compiled).map_err(|error| {
                PolicyStoreError::CorruptData(format!(
                    "could not serialize compiled rule {index}: {error}"
                ))
            })?;
            let hash = source_hash(&rule.source);
            let previous = rule.id.as_ref().and_then(|id| existing.get(id));
            let version = match previous {
                Some(previous) if previous.source_hash == hash => previous.version,
                Some(previous) => previous.version.checked_add(1).ok_or_else(|| {
                    PolicyStoreError::CorruptData("policy rule version overflow".to_string())
                })?,
                None => 1,
            };
            Ok(CompiledRule {
                id: previous
                    .map(|previous| previous.id.clone())
                    .unwrap_or_else(crate::util::new_id),
                position: index as i64,
                source_hash: hash,
                time_dependent: is_time_dependent(&rule.source, &compiled),
                source: rule.source,
                compiled_json,
                enabled: rule.enabled,
                version,
                existing: previous.is_some(),
                created_at: previous.map(|previous| previous.created_at),
            })
        })
        .collect()
}

async fn load_existing_rules(
    db: &D1Database,
    set_id: &str,
) -> StoreResult<HashMap<String, ExistingRuleRow>> {
    let rows = db
        .prepare(
            "SELECT id, source_hash, version, created_at FROM policy_rules WHERE policy_set_id = ?1",
        )
        .bind(&[s(set_id)])?
        .all()
        .await?
        .results::<ExistingRuleRow>()?;
    Ok(rows.into_iter().map(|row| (row.id.clone(), row)).collect())
}

async fn find_set(
    db: &D1Database,
    person_id: &str,
    scope: PolicyScope,
    activity_id: Option<&str>,
) -> StoreResult<Option<PolicySetRow>> {
    let row = match scope {
        PolicyScope::Home => {
            db.prepare(
                "SELECT id, scope, activity_id, revision, created_at \
                 FROM policy_sets WHERE person_id = ? AND scope = 'home'",
            )
            .bind(&[s(person_id)])?
            .first::<PolicySetRow>(None)
            .await?
        }
        PolicyScope::Room => {
            db.prepare(
                "SELECT id, scope, activity_id, revision, created_at \
                 FROM policy_sets WHERE person_id = ? AND scope = 'room' AND activity_id = ?",
            )
            .bind(&[s(person_id), s(activity_id.unwrap_or_default())])?
            .first::<PolicySetRow>(None)
            .await?
        }
    };
    Ok(row)
}

async fn replace_existing(
    db: &D1Database,
    person_id: &str,
    current: PolicySetRow,
    timezone: String,
    rules: Vec<CompiledRule>,
    now: i64,
) -> StoreResult<PolicySetResponse> {
    let next_revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| PolicyStoreError::CorruptData("policy set revision overflow".to_string()))?;
    let lock_revision = new_lock_revision();
    let mut statements = vec![db
        .prepare(
            "UPDATE policy_sets SET revision = ?1 \
             WHERE id = ?2 AND person_id = ?3 AND revision = ?4",
        )
        .bind(&[
            i(lock_revision),
            s(&current.id),
            s(person_id),
            i(current.revision),
        ])?];
    let retained_ids = rules
        .iter()
        .filter(|rule| rule.existing)
        .map(|rule| rule.id.as_str())
        .collect::<Vec<_>>();
    if retained_ids.is_empty() {
        statements.push(
            db.prepare(
                "DELETE FROM policy_rules WHERE policy_set_id = ?1 \
                 AND EXISTS (SELECT 1 FROM policy_sets WHERE id = ?1 AND revision = ?2)",
            )
            .bind(&[s(&current.id), i(lock_revision)])?,
        );
    } else {
        let placeholders = (0..retained_ids.len())
            .map(|index| format!("?{}", index + 3))
            .collect::<Vec<_>>()
            .join(",");
        let mut values = vec![s(&current.id), i(lock_revision)];
        values.extend(retained_ids.iter().map(|id| s(id)));
        statements.push(
            db.prepare(format!(
                "DELETE FROM policy_rules WHERE policy_set_id = ?1 AND id NOT IN ({placeholders}) \
                 AND EXISTS (SELECT 1 FROM policy_sets WHERE id = ?1 AND revision = ?2)"
            ))
            .bind(&values)?,
        );
    }
    statements.push(
        db.prepare(
            "UPDATE policy_rules SET position = position + 1000 \
             WHERE policy_set_id = ?1 \
               AND EXISTS (SELECT 1 FROM policy_sets WHERE id = ?1 AND revision = ?2)",
        )
        .bind(&[s(&current.id), i(lock_revision)])?,
    );
    for rule in &rules {
        if rule.existing {
            statements.push(
                db.prepare(
                    "UPDATE policy_rules SET position = ?1, source = ?2, compiled_json = ?3, \
                       source_hash = ?4, time_dependent = ?5, enabled = ?6, version = ?7, updated_at = ?8 \
                     WHERE id = ?9 AND policy_set_id = ?10 \
                       AND EXISTS (SELECT 1 FROM policy_sets WHERE id = ?10 AND revision = ?11)",
                )
                .bind(&[
                    i(rule.position),
                    s(&rule.source),
                    s(&rule.compiled_json),
                    s(&rule.source_hash),
                    i(rule.time_dependent as i64),
                    i(rule.enabled as i64),
                    i(rule.version),
                    i(now),
                    s(&rule.id),
                    s(&current.id),
                    i(lock_revision),
                ])?,
            );
        } else {
            append_rule_insert(db, &mut statements, &current.id, lock_revision, rule, now)?;
        }
    }
    statements.push(
        db.prepare(
            "UPDATE policy_sets SET timezone = ?1, revision = ?2, updated_at = ?3 \
             WHERE id = ?4 AND revision = ?5",
        )
        .bind(&[
            s(&timezone),
            i(next_revision),
            i(now),
            s(&current.id),
            i(lock_revision),
        ])?,
    );

    let results = db.batch(statements).await?;
    if mutation_changes(&results)? != 1 {
        let actual = find_set(
            db,
            person_id,
            PolicyScope::parse(&current.scope)?,
            current.activity_id.as_deref(),
        )
        .await?
        .map(|row| row.revision);
        return Err(PolicyStoreError::Conflict {
            expected_revision: current.revision,
            actual_revision: actual,
        });
    }

    Ok(response_from_compiled(
        current.id,
        PolicyScope::parse(&current.scope)?,
        current.activity_id,
        timezone,
        next_revision,
        current.created_at,
        now,
        rules,
    ))
}

async fn create_set(
    db: &D1Database,
    person_id: &str,
    request: ReplacePolicySetRequest,
    rules: Vec<CompiledRule>,
    now: i64,
) -> StoreResult<PolicySetResponse> {
    let set_id = crate::util::new_id();
    let mut statements = vec![db
        .prepare(
            "INSERT OR IGNORE INTO policy_sets \
               (id, person_id, scope, activity_id, timezone, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        )
        .bind(&[
            s(&set_id),
            s(person_id),
            s(request.scope.as_str()),
            os(request.activity_id.as_deref()),
            s(&request.timezone),
            i(now),
        ])?];
    append_rule_inserts(db, &mut statements, &set_id, 1, &rules, now)?;

    let results = db.batch(statements).await?;
    if mutation_changes(&results)? != 1 {
        let actual = find_set(db, person_id, request.scope, request.activity_id.as_deref())
            .await?
            .map(|row| row.revision);
        return Err(PolicyStoreError::Conflict {
            expected_revision: 0,
            actual_revision: actual,
        });
    }

    Ok(response_from_compiled(
        set_id,
        request.scope,
        request.activity_id,
        request.timezone,
        1,
        now,
        now,
        rules,
    ))
}

fn append_rule_inserts(
    db: &D1Database,
    statements: &mut Vec<worker::D1PreparedStatement>,
    set_id: &str,
    revision: i64,
    rules: &[CompiledRule],
    now: i64,
) -> StoreResult<()> {
    for rule in rules {
        append_rule_insert(db, statements, set_id, revision, rule, now)?;
    }
    Ok(())
}

fn append_rule_insert(
    db: &D1Database,
    statements: &mut Vec<worker::D1PreparedStatement>,
    set_id: &str,
    revision: i64,
    rule: &CompiledRule,
    now: i64,
) -> StoreResult<()> {
    statements.push(
        db.prepare(
            "INSERT INTO policy_rules \
               (id, policy_set_id, position, source, compiled_json, source_hash, \
                time_dependent, enabled, version, created_at, updated_at) \
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 \
             WHERE EXISTS (SELECT 1 FROM policy_sets WHERE id = ?2 AND revision = ?11)",
        )
        .bind(&[
            s(&rule.id),
            s(set_id),
            i(rule.position),
            s(&rule.source),
            s(&rule.compiled_json),
            s(&rule.source_hash),
            i(rule.time_dependent as i64),
            i(rule.enabled as i64),
            i(rule.version),
            i(now),
            i(revision),
        ])?,
    );
    Ok(())
}

fn mutation_changes(results: &[worker::D1Result]) -> StoreResult<usize> {
    let first = results.first().ok_or_else(|| {
        PolicyStoreError::CorruptData("D1 returned no result for policy mutation".to_string())
    })?;
    Ok(first
        .meta()?
        .and_then(|metadata| metadata.changes)
        .unwrap_or(0))
}

fn new_lock_revision() -> i64 {
    let id = crate::util::new_id();
    // Twelve hex digits fit exactly in the f64-backed D1 integer binding.
    let value = i64::from_str_radix(&id[..12], 16).expect("new_id must be hexadecimal");
    -(value + 1)
}

#[allow(clippy::too_many_arguments)]
fn response_from_compiled(
    id: String,
    scope: PolicyScope,
    activity_id: Option<String>,
    timezone: String,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    rules: Vec<CompiledRule>,
) -> PolicySetResponse {
    PolicySetResponse {
        id,
        scope,
        activity_id,
        timezone,
        revision,
        created_at,
        updated_at,
        rules: rules
            .into_iter()
            .map(|rule| PolicyRuleResponse {
                id: rule.id,
                position: rule.position,
                source: rule.source,
                source_hash: rule.source_hash,
                time_dependent: rule.time_dependent,
                enabled: rule.enabled,
                version: rule.version,
                created_at: rule.created_at.unwrap_or(updated_at),
                updated_at,
            })
            .collect(),
    }
}

fn responses_from_rows(rows: Vec<JoinedRow>) -> StoreResult<Vec<PolicySetResponse>> {
    let mut sets: Vec<PolicySetResponse> = Vec::new();
    for row in rows {
        if sets.last().map(|set| set.id.as_str()) != Some(row.set_id.as_str()) {
            sets.push(PolicySetResponse {
                id: row.set_id.clone(),
                scope: PolicyScope::parse(&row.scope)?,
                activity_id: row.activity_id.clone(),
                timezone: row.timezone.clone(),
                revision: row.revision,
                created_at: row.set_created_at,
                updated_at: row.set_updated_at,
                rules: Vec::new(),
            });
        }
        if let Some(rule) = response_rule_from_joined(&row)? {
            sets.last_mut()
                .expect("set was just inserted")
                .rules
                .push(rule);
        }
    }
    Ok(sets)
}

fn response_rule_from_joined(row: &JoinedRow) -> StoreResult<Option<PolicyRuleResponse>> {
    let Some(id) = row.rule_id.clone() else {
        return Ok(None);
    };
    Ok(Some(PolicyRuleResponse {
        id,
        position: required(row.position, "position")?,
        source: required(row.source.clone(), "source")?,
        source_hash: required(row.source_hash.clone(), "source_hash")?,
        time_dependent: required(row.time_dependent, "time_dependent")? != 0,
        enabled: required(row.enabled, "enabled")? != 0,
        version: required(row.version, "version")?,
        created_at: required(row.rule_created_at, "rule created_at")?,
        updated_at: required(row.rule_updated_at, "rule updated_at")?,
    }))
}

fn effective_from_rows(rows: Vec<JoinedRow>) -> StoreResult<Option<EffectivePolicySet>> {
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let mut set = EffectivePolicySet {
        id: first.set_id.clone(),
        scope: PolicyScope::parse(&first.scope)?,
        timezone: first.timezone.clone(),
        rules: Vec::new(),
    };
    for row in rows {
        let Some(id) = row.rule_id else {
            continue;
        };
        let compiled_json = required(row.compiled_json, "compiled_json")?;
        let compiled = serde_json::from_str(&compiled_json).map_err(|error| {
            PolicyStoreError::CorruptData(format!("rule {id} has invalid compiled_json: {error}"))
        })?;
        set.rules.push(EffectivePolicyRule {
            id,
            compiled,
            time_dependent: required(row.time_dependent, "time_dependent")? != 0,
            enabled: required(row.enabled, "enabled")? != 0,
            version: required(row.version, "version")?,
        });
    }
    Ok(Some(set))
}

fn required<T>(value: Option<T>, column: &str) -> StoreResult<T> {
    value.ok_or_else(|| {
        PolicyStoreError::CorruptData(format!("rule row is missing column {column}"))
    })
}

pub fn source_hash(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    let mut hash = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hash.push_str(&format!("{byte:02x}"));
    }
    hash
}

/// Detect policies that can change solely because wall-clock time advances.
/// Raw source scanning intentionally permits false positives (including names
/// in comments or strings), while the AST walk catches every expression site.
pub fn is_time_dependent(source: &str, program: &TypedProgram) -> bool {
    source_identifiers(source).any(is_time_name)
        || program
            .bindings
            .iter()
            .any(|binding| expr_uses_time(&binding.value))
        || expr_uses_time(&program.action)
        || program.decls.iter().any(|decl| match decl {
            Decl::Impl(implementation) => implementation
                .methods
                .iter()
                .any(|binding| expr_uses_time(&binding.value)),
            Decl::Type(_) | Decl::Trait(_) => false,
        })
}

fn source_identifiers(source: &str) -> impl Iterator<Item = &str> {
    source
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .filter(|word| !word.is_empty())
}

fn is_time_name(name: &str) -> bool {
    matches!(name, "now" | "today" | "ready_in" | "eta" | "waited")
}

fn expr_uses_time(expr: &Expr) -> bool {
    match expr {
        Expr::Var(name) => is_time_name(name),
        Expr::Str(segments) => segments.iter().any(|segment| match segment {
            StrSeg::Expr(expr) => expr_uses_time(expr),
            StrSeg::Lit(_) => false,
        }),
        Expr::List(items) | Expr::Tuple(items) | Expr::Block(items) => {
            items.iter().any(expr_uses_time)
        }
        Expr::Record(fields) => fields.iter().any(|(_, value)| expr_uses_time(value)),
        Expr::Field { base, .. }
        | Expr::TupleIndex { base, .. }
        | Expr::Lambda { body: base, .. }
        | Expr::Unary { expr: base, .. } => expr_uses_time(base),
        Expr::Index { base, index } => expr_uses_time(base) || expr_uses_time(index),
        Expr::Apply { func, arg } => expr_uses_time(func) || expr_uses_time(arg),
        Expr::If { cond, then, els } => {
            expr_uses_time(cond) || expr_uses_time(then) || expr_uses_time(els)
        }
        Expr::Match { scrutinee, arms } => {
            expr_uses_time(scrutinee) || arms.iter().any(|arm| expr_uses_time(&arm.body))
        }
        Expr::Binary { left, right, .. } | Expr::Cons(left, right) => {
            expr_uses_time(left) || expr_uses_time(right)
        }
        Expr::Num(_) | Expr::Bool(_) | Expr::DurationSecs(_) | Expr::Ctor(_) => false,
    }
}

fn s(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn os(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}

fn i(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined_empty_set(scope: &str) -> JoinedRow {
        JoinedRow {
            set_id: "set-1".to_string(),
            scope: scope.to_string(),
            activity_id: (scope == "room").then(|| "activity-1".to_string()),
            timezone: "UTC".to_string(),
            revision: 3,
            set_created_at: 10,
            set_updated_at: 20,
            rule_id: None,
            position: None,
            source: None,
            compiled_json: None,
            source_hash: None,
            time_dependent: None,
            enabled: None,
            version: None,
            rule_created_at: None,
            rule_updated_at: None,
        }
    }

    #[test]
    fn hashes_source_as_lowercase_sha256() {
        assert_eq!(
            source_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn detects_time_names_but_not_identifier_substrings() {
        let static_program = policy::compile_policy("true => notify \"ready\"").unwrap();
        assert!(!is_time_dependent(
            "true => notify \"ready\"",
            &static_program
        ));
        assert!(!is_time_dependent(
            "todayish = true\ntodayish => notify \"ready\"",
            &policy::compile_policy("todayish = true\ntodayish => notify \"ready\"").unwrap()
        ));

        for source in [
            "now.hour == 12 => notify \"lunch\"",
            "is_weekend today => notify \"weekend\"",
            "match ready_in with | Some(t) -> delay (notify \"go\") t | None -> {}",
            "any (fun p -> waited p > 2min) committed => notify \"late\"",
        ] {
            let program = policy::compile_policy(source).unwrap();
            assert!(is_time_dependent(source, &program), "{source}");
        }
    }

    #[test]
    fn source_scan_is_deliberately_conservative() {
        let program = policy::compile_policy("notify \"now\"").unwrap();
        assert!(is_time_dependent("notify \"now\"", &program));
    }

    #[test]
    fn response_assembly_preserves_an_empty_room_override() {
        let sets = responses_from_rows(vec![joined_empty_set("room")]).unwrap();
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].scope, PolicyScope::Room);
        assert!(sets[0].rules.is_empty());
    }

    #[test]
    fn effective_assembly_preserves_an_empty_room_override() {
        let set = effective_from_rows(vec![joined_empty_set("room")])
            .unwrap()
            .unwrap();
        assert_eq!(set.scope, PolicyScope::Room);
        assert!(set.rules.is_empty());
    }

    #[test]
    fn validates_scope_limits_and_source_bytes() {
        let valid = ReplacePolicySetRequest {
            scope: PolicyScope::Room,
            activity_id: Some("activity-1".to_string()),
            timezone: "UTC".to_string(),
            revision: 0,
            rules: Vec::new(),
        };
        assert!(validate_request(&valid).is_ok());

        let invalid_home = ReplacePolicySetRequest {
            scope: PolicyScope::Home,
            activity_id: Some("activity-1".to_string()),
            ..valid.clone()
        };
        assert_eq!(
            validate_request(&invalid_home).unwrap_err().status_code(),
            400
        );

        let too_many = ReplacePolicySetRequest {
            rules: (0..=MAX_RULES)
                .map(|_| PolicyRuleRequest {
                    id: None,
                    source: "{}".to_string(),
                    enabled: true,
                })
                .collect(),
            ..valid.clone()
        };
        assert!(validate_request(&too_many).is_err());

        let too_large = ReplacePolicySetRequest {
            rules: vec![PolicyRuleRequest {
                id: None,
                source: "x".repeat(MAX_SOURCE_BYTES + 1),
                enabled: true,
            }],
            ..valid
        };
        assert!(validate_request(&too_large).is_err());
    }

    #[test]
    fn compile_errors_identify_the_rule_and_map_to_bad_request() {
        let error = compile_rules(
            vec![PolicyRuleRequest {
                id: None,
                source: "true => 42".to_string(),
                enabled: true,
            }],
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            PolicyStoreError::Compile { rule_index: 0, .. }
        ));
        assert_eq!(error.status_code(), 400);
    }
}
