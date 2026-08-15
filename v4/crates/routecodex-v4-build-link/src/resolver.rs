//! Active artifact resolver: identity -> manifest/hash -> records -> target ->
//! dependency closure -> link flags. Fail-fast, no fallback.

use crate::error::ActiveLinkError;
use crate::identity::{
    canonical, recompute_artifact_hash, recompute_public_api_hash, sha256_hex,
    ActiveArtifactDependency, ActiveArtifactIdentity, ActiveArtifactResolution, ArtifactEntry,
};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Parsed `rustc -vV` facts used to bind the target triple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustcFacts {
    pub release: String,
    pub host: String,
}

fn rustc_facts() -> Result<&'static RustcFacts, ActiveLinkError> {
    static FACTS: OnceLock<Result<RustcFacts, String>> = OnceLock::new();
    FACTS
        .get_or_init(|| {
            let output = Command::new("rustc")
                .arg("-vV")
                .output()
                .map_err(|e| format!("run rustc -vV: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "rustc -vV failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            let release = text
                .lines()
                .find_map(|line| line.strip_prefix("release: "))
                .ok_or_else(|| "rustc -vV missing release".to_string())?
                .to_string();
            let host = text
                .lines()
                .find_map(|line| line.strip_prefix("host: "))
                .ok_or_else(|| "rustc -vV missing host".to_string())?
                .to_string();
            Ok(RustcFacts { release, host })
        })
        .as_ref()
        .map_err(|message| ActiveLinkError::TargetMismatch(message.clone()))
}

/// Current rustc host triple (e.g. aarch64-apple-darwin).
pub fn host_triple() -> Result<String, ActiveLinkError> {
    Ok(rustc_facts()?.host.clone())
}

/// Current rustc release line (e.g. 1.97.1).
pub fn rustc_version() -> Result<String, ActiveLinkError> {
    Ok(rustc_facts()?.release.clone())
}

/// Frozen module ids declared in `contracts/active-link/frozen-consumer-registry.json`.
/// These modules may only be consumed through the Active surface.
pub fn frozen_module_ids(root: &Path) -> Result<HashSet<String>, ActiveLinkError> {
    let path = root.join("contracts/active-link/frozen-consumer-registry.json");
    let text = fs::read_to_string(&path).map_err(|e| {
        ActiveLinkError::ManifestInvalid(format!(
            "read frozen-consumer-registry {}: {e}",
            path.display()
        ))
    })?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        ActiveLinkError::ManifestInvalid(format!(
            "parse frozen-consumer-registry {}: {e}",
            path.display()
        ))
    })?;
    let ids = value
        .get("frozen_modules")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// Resolve a mutable workspace crate to its cargo-built release rlib and
/// return rustc `--extern` + `-L dependency` arguments. Frozen modules are
/// rejected: their only consumption surface is the Active artifact resolver.
pub fn source_dep_link_args(
    root: &Path,
    name: &str,
    frozen: &HashSet<String>,
) -> Result<Vec<String>, ActiveLinkError> {
    if frozen.contains(name) {
        return Err(ActiveLinkError::LinkFailed(format!(
            "frozen module {name} must be consumed through the Active surface, not --source-deps"
        )));
    }
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(ActiveLinkError::IdentityMissing(format!(
            "invalid source dependency {name:?}"
        )));
    }
    let source_dir = root.join("crates").join(name);
    if !source_dir.join("src/lib.rs").is_file() {
        return Err(ActiveLinkError::LinkFailed(format!(
            "source dependency {name} has no src/lib.rs at {}",
            source_dir.display()
        )));
    }
    let rust_name = name.replace('-', "_");
    let deps_dir = root.join("target/release/deps");
    let mut candidates: Vec<PathBuf> = fs::read_dir(&deps_dir)
        .map_err(|e| {
            ActiveLinkError::LinkFailed(format!(
                "read {}: {e} (build the workspace crate first with `cargo build --release --manifest-path v4/Cargo.toml -p {name}`)",
                deps_dir.display()
            ))
        })?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|file| {
                    let file = file.to_string_lossy();
                    file.starts_with(&format!("lib{rust_name}-")) && file.ends_with(".rlib")
                })
                .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    let rlib = candidates.pop().ok_or_else(|| {
        ActiveLinkError::LinkFailed(format!(
            "no release rlib for source dependency {rust_name} in {} (run `cargo build --release --manifest-path v4/Cargo.toml -p {name}` first)",
            deps_dir.display()
        ))
    })?;
    Ok(vec![
        "--extern".to_string(),
        format!("{rust_name}={}", rlib.display()),
        "-L".to_string(),
        format!("dependency={}", deps_dir.display()),
    ])
}

/// Fail if `path` resolves inside the Active zone (`active/**`).
pub fn assert_outside_active(root: &Path, path: &Path) -> Result<(), ActiveLinkError> {
    let root = root
        .canonicalize()
        .map_err(|e| ActiveLinkError::IdentityMissing(format!("canonicalize root: {e}")))?;
    let active_root = root.join("active");
    // Canonicalize the deepest existing ancestor so a not-yet-created target
    // (including symlinked prefixes such as /tmp -> /private/tmp) is still
    // compared against the canonical Active root before any write.
    let mut existing = path;
    let mut suffix = Vec::new();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            break;
        };
        let Some(name) = existing.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        existing = parent;
    }
    let canonical_existing = existing.canonicalize().map_err(|e| {
        ActiveLinkError::IdentityMissing(format!("canonicalize {}: {e}", existing.display()))
    })?;
    let canonical_path = suffix
        .iter()
        .rev()
        .fold(canonical_existing, |acc, component| acc.join(component));
    if canonical_path.starts_with(&active_root) {
        return Err(ActiveLinkError::ActiveWriteForbidden(format!(
            "write target {} is inside Active zone",
            path.display()
        )));
    }
    Ok(())
}

fn validate_identity_component(module_id: &str, version: &str) -> Result<(), ActiveLinkError> {
    if module_id.is_empty()
        || !module_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(ActiveLinkError::IdentityMissing(format!(
            "invalid module_id {module_id:?}"
        )));
    }
    let Some(rest) = version.strip_prefix("active-v") else {
        return Err(ActiveLinkError::IdentityMissing(format!(
            "invalid active version {version:?}"
        )));
    };
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return Err(ActiveLinkError::IdentityMissing(format!(
            "invalid active version {version:?}"
        )));
    }
    Ok(())
}

fn assert_no_symlink_components(root: &Path, path: &Path) -> Result<(), ActiveLinkError> {
    let root = root
        .canonicalize()
        .map_err(|e| ActiveLinkError::IdentityMissing(format!("canonicalize root: {e}")))?;
    let relative = path.strip_prefix(&root).map_err(|_| {
        ActiveLinkError::SymlinkOrPathEscape(format!(
            "path {} escapes root {}",
            path.display(),
            root.display()
        ))
    })?;
    let mut current = root.clone();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|e| {
            ActiveLinkError::SymlinkOrPathEscape(format!("stat {}: {e}", current.display()))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ActiveLinkError::SymlinkOrPathEscape(format!(
                "symlink component in {}",
                current.display()
            )));
        }
    }
    Ok(())
}

fn safe_relative_artifact_path(relative: &str) -> Result<PathBuf, ActiveLinkError> {
    if relative.is_empty() {
        return Err(ActiveLinkError::SymlinkOrPathEscape(
            "empty artifact path".into(),
        ));
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::CurDir | Component::Prefix(_)
            )
        })
    {
        return Err(ActiveLinkError::SymlinkOrPathEscape(format!(
            "unsafe artifact path {relative:?}"
        )));
    }
    Ok(candidate.to_path_buf())
}

fn read_json(
    path: &Path,
    missing_error: ActiveLinkError,
) -> Result<serde_json::Value, ActiveLinkError> {
    let text = fs::read_to_string(path).map_err(|e| match missing_error {
        ActiveLinkError::ArtifactMissing(_) => {
            ActiveLinkError::ArtifactMissing(format!("read {}: {e}", path.display()))
        }
        _ => missing_error,
    })?;
    serde_json::from_str(&text)
        .map_err(|e| ActiveLinkError::ManifestInvalid(format!("parse {}: {e}", path.display())))
}

fn read_record(
    root: &Path,
    module_id: &str,
    name: &str,
) -> Result<serde_json::Value, ActiveLinkError> {
    let path = root
        .join(".appsdk/records")
        .join(format!("{name}-{module_id}.json"));
    fs::read_to_string(&path)
        .map_err(|e| ActiveLinkError::StaleOrMissingRecord(format!("read {}: {e}", path.display())))
        .and_then(|text| {
            serde_json::from_str(&text).map_err(|e| {
                ActiveLinkError::StaleOrMissingRecord(format!("parse {}: {e}", path.display()))
            })
        })
}

fn record_str<'a>(record: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    record.get(key).and_then(serde_json::Value::as_str)
}

fn crate_name(module_id: &str) -> String {
    module_id.replace('-', "_")
}

/// Emit `--extern <crate>=<rlib>` flags for the resolution and its full
/// dependency closure. Flags are deterministic and de-duplicated.
pub fn emit_link_flags(resolution: &ActiveArtifactResolution) -> Vec<String> {
    let mut flags = Vec::new();
    let mut seen = HashSet::new();
    fn walk(
        resolution: &ActiveArtifactResolution,
        flags: &mut Vec<String>,
        seen: &mut HashSet<String>,
    ) {
        for rlib in &resolution.rlib_paths {
            let flag = format!(
                "--extern {}={}",
                crate_name(&resolution.identity.module_id),
                rlib.display()
            );
            if seen.insert(flag.clone()) {
                flags.push(flag);
            }
        }
        for dependency in &resolution.dependency_resolutions {
            walk(dependency, flags, seen);
        }
    }
    walk(resolution, &mut flags, &mut seen);
    flags
}

fn find_dependency_version(
    root: &Path,
    dependency_module: &str,
    dependency_hash: &str,
    target: &str,
    visiting: &mut Vec<(String, String)>,
) -> Result<ActiveArtifactResolution, ActiveLinkError> {
    validate_identity_component(dependency_module, "active-v0").map_err(|_| {
        ActiveLinkError::DependencyClosureMismatch(format!(
            "invalid dependency module {dependency_module:?}"
        ))
    })?;
    let module_dir = root.join("active/lib").join(dependency_module);
    if !module_dir.is_dir() {
        return Err(ActiveLinkError::DependencyClosureMismatch(format!(
            "dependency {dependency_module} has no Active root"
        )));
    }
    let mut versions = Vec::new();
    for entry in fs::read_dir(&module_dir).map_err(|e| {
        ActiveLinkError::DependencyClosureMismatch(format!("read {}: {e}", module_dir.display()))
    })? {
        let entry = entry.map_err(|e| {
            ActiveLinkError::DependencyClosureMismatch(format!("read_dir entry: {e}"))
        })?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let version = entry.file_name().to_string_lossy().into_owned();
        if version.starts_with("active-v") {
            versions.push(version);
        }
    }
    versions.sort();
    for version in versions {
        let candidate = resolve_inner(root, dependency_module, &version, target, visiting)?;
        if candidate.identity.artifact_hash == dependency_hash {
            return Ok(candidate);
        }
    }
    Err(ActiveLinkError::DependencyClosureMismatch(format!(
        "dependency {dependency_module} has no Active version matching artifact hash {dependency_hash}"
    )))
}

/// Resolve a frozen module Active artifact and validate the full contract.
///
/// Public entrypoint (no cycle-guard plumbing exposed).
pub fn resolve(
    root: &Path,
    module_id: &str,
    version: &str,
    target: &str,
) -> Result<ActiveArtifactResolution, ActiveLinkError> {
    resolve_inner(root, module_id, version, target, &mut Vec::new())
}

/// Internal resolver with an explicit dependency-closure visiting stack.
///
/// Validation order (fail-fast, first mismatch wins):
/// 1. identity (module_id + active_version)
/// 2. freeze record exists (module must be frozen)
/// 3. Active version directory + artifact.json exist
/// 4. artifact entry path safety + symlink/escape checks
/// 5. artifact file hashes match `artifacts[].hash`
/// 6. public_api_hash recompute matches record
/// 7. artifact_hash recompute matches record
/// 8. record graph (freeze/promotion/review/evidence) consistency
/// 9. target triple vs rustc host
/// 10. dependency closure (recursive, cycle-guarded)
fn resolve_inner(
    root: &Path,
    module_id: &str,
    version: &str,
    target: &str,
    visiting: &mut Vec<(String, String)>,
) -> Result<ActiveArtifactResolution, ActiveLinkError> {
    let key = (module_id.to_string(), version.to_string());
    if visiting.contains(&key) {
        return Err(ActiveLinkError::DependencyClosureMismatch(format!(
            "dependency cycle at {} {}",
            key.0, key.1
        )));
    }
    visiting.push(key);
    let result = resolve_impl(root, module_id, version, target, visiting);
    visiting.pop();
    result
}

fn resolve_impl(
    root: &Path,
    module_id: &str,
    version: &str,
    target: &str,
    visiting: &mut Vec<(String, String)>,
) -> Result<ActiveArtifactResolution, ActiveLinkError> {
    validate_identity_component(module_id, version)?;
    let root = root
        .canonicalize()
        .map_err(|e| ActiveLinkError::IdentityMissing(format!("canonicalize root: {e}")))?;

    // 2. freeze record gate: mutable/unknown modules are never resolvable.
    let freeze = read_record(&root, module_id, "freeze-record")?;

    // 3. Active version directory.
    let version_dir = root.join("active/lib").join(module_id).join(version);
    if !version_dir.is_dir() {
        return Err(ActiveLinkError::ArtifactMissing(format!(
            "no Active version {version} for {module_id} at {}",
            version_dir.display()
        )));
    }
    assert_no_symlink_components(&root, &version_dir)?;
    let artifact_file = version_dir.join("artifact.json");
    if !artifact_file.is_file() {
        return Err(ActiveLinkError::ArtifactMissing(format!(
            "{} missing",
            artifact_file.display()
        )));
    }
    assert_no_symlink_components(&root, &artifact_file)?;
    let artifact = read_json(
        &artifact_file,
        ActiveLinkError::ArtifactMissing(format!("{} missing", artifact_file.display())),
    )?;

    // 4-5. artifact entries: safety first, then byte hashes.
    let entries_value = artifact
        .get("artifacts")
        .and_then(serde_json::Value::as_array);
    let mut entries = Vec::new();
    let mut rlib_paths = Vec::new();
    if let Some(entries_value) = entries_value {
        for entry_value in entries_value {
            let relative = record_str(entry_value, "path").ok_or_else(|| {
                ActiveLinkError::ManifestInvalid(format!("{module_id} artifact entry missing path"))
            })?;
            let recorded_hash = record_str(entry_value, "hash").ok_or_else(|| {
                ActiveLinkError::ManifestInvalid(format!("{module_id} artifact entry missing hash"))
            })?;
            let safe_path = safe_relative_artifact_path(relative)?;
            let target_file = version_dir.join("lib").join(&safe_path);
            assert_no_symlink_components(&root, &target_file)?;
            if !target_file.is_file() {
                return Err(ActiveLinkError::ArtifactMissing(format!(
                    "artifact file {} missing",
                    target_file.display()
                )));
            }
            let actual_hash = sha256_hex(&fs::read(&target_file).map_err(|e| {
                ActiveLinkError::ArtifactHashMismatch(format!(
                    "read {}: {e}",
                    target_file.display()
                ))
            })?);
            if actual_hash != recorded_hash {
                return Err(ActiveLinkError::ArtifactHashMismatch(format!(
                    "{}: recorded {} != actual {}",
                    target_file.display(),
                    recorded_hash,
                    actual_hash
                )));
            }
            entries.push(ArtifactEntry {
                path: relative.to_string(),
                hash: recorded_hash.to_string(),
            });
            rlib_paths.push(target_file);
        }
    }

    // 6. public_api_hash is the contract binding of the entry set.
    let recorded_public_api_hash = record_str(&artifact, "public_api_hash").ok_or_else(|| {
        ActiveLinkError::ManifestInvalid(format!("{module_id} artifact missing public_api_hash"))
    })?;
    let recomputed_public_api_hash = recompute_public_api_hash(&entries);
    if recomputed_public_api_hash != recorded_public_api_hash {
        return Err(ActiveLinkError::PublicApiHashMismatch(format!(
            "{module_id} {version}: recorded {recorded_public_api_hash} != recomputed {recomputed_public_api_hash}"
        )));
    }

    // 7. artifact_hash binds the whole manifest object.
    let recorded_artifact_hash = record_str(&artifact, "artifact_hash").ok_or_else(|| {
        ActiveLinkError::ManifestInvalid(format!("{module_id} artifact missing artifact_hash"))
    })?;
    let recomputed_artifact_hash = recompute_artifact_hash(&artifact)?;
    if recomputed_artifact_hash != recorded_artifact_hash {
        return Err(ActiveLinkError::ArtifactHashMismatch(format!(
            "{module_id} {version}: recorded {recorded_artifact_hash} != recomputed {recomputed_artifact_hash}"
        )));
    }

    // 8. record graph: freeze + promotion + review + evidence must agree.
    let source_commit = record_str(&freeze, "source_commit_or_tag")
        .ok_or_else(|| {
            ActiveLinkError::StaleOrMissingRecord(format!(
                "freeze record {module_id} missing source_commit_or_tag"
            ))
        })?
        .to_string();
    for key in ["library_hash", "public_api_hash"] {
        let recorded = record_str(&freeze, key).ok_or_else(|| {
            ActiveLinkError::StaleOrMissingRecord(format!(
                "freeze record {module_id} missing {key}"
            ))
        })?;
        let expected = if key == "library_hash" {
            recorded_artifact_hash
        } else {
            recorded_public_api_hash
        };
        if recorded != expected {
            return Err(ActiveLinkError::StaleOrMissingRecord(format!(
                "freeze record {module_id} {key} {recorded} != artifact {expected}"
            )));
        }
    }
    let promotion = read_record(&root, module_id, "promotion-record")?;
    let review = read_record(&root, module_id, "review-record")?;
    let evidence = read_record(&root, module_id, "evidence-record")?;
    for (name, record) in [
        ("promotion", &promotion),
        ("review", &review),
        ("evidence", &evidence),
    ] {
        let artifact_match = match name {
            "promotion" => record_str(record, "artifact_hash") == Some(recorded_artifact_hash),
            "review" => {
                record_str(record, "reviewed_artifact_hash") == Some(recorded_artifact_hash)
            }
            _ => record_str(record, "artifact_hash") == Some(recorded_artifact_hash),
        };
        if !artifact_match {
            return Err(ActiveLinkError::StaleOrMissingRecord(format!(
                "{name} record {module_id} artifact hash does not match Active artifact"
            )));
        }
    }
    if record_str(&review, "verdict") != Some("pass") {
        return Err(ActiveLinkError::StaleOrMissingRecord(format!(
            "review record {module_id} verdict is not pass"
        )));
    }
    if record_str(&promotion, "source_commit") != Some(source_commit.as_str())
        || record_str(&evidence, "source_commit") != Some(source_commit.as_str())
    {
        return Err(ActiveLinkError::StaleOrMissingRecord(format!(
            "record graph {module_id} source commit does not match freeze record"
        )));
    }

    // 9. target triple binding.
    let facts = rustc_facts()?;
    if target != facts.host {
        return Err(ActiveLinkError::TargetMismatch(format!(
            "requested {target} but rustc host is {}",
            facts.host
        )));
    }
    // 9a. producer rustc binding: when the freeze record records the producer
    // toolchain, the current rustc release must match before any link flags
    // are emitted (design §10.1, no auto-rebuild). Existing frozen artifacts
    // predate this field; they stay bound by artifact hash + host triple.
    let producer_rustc_version = record_str(&freeze, "rustc_version").map(str::to_string);
    if let Some(producer) = &producer_rustc_version {
        if producer != &facts.release {
            return Err(ActiveLinkError::RustcMismatch(format!(
                "{module_id} {version}: producer rustc {producer} != current rustc {}",
                facts.release
            )));
        }
    }

    // 10. dependency closure.
    let mut dependency_resolutions = Vec::new();
    let mut dependencies = Vec::new();
    if let Some(dep_entries) = artifact
        .get("dependency_hashes")
        .and_then(serde_json::Value::as_array)
    {
        for dep in dep_entries {
            let dep_module = record_str(dep, "module_id").ok_or_else(|| {
                ActiveLinkError::DependencyClosureMismatch(format!(
                    "{module_id} dependency entry missing module_id"
                ))
            })?;
            let dep_hash = record_str(dep, "artifact_hash").ok_or_else(|| {
                ActiveLinkError::DependencyClosureMismatch(format!(
                    "{module_id} dependency {dep_module} missing artifact_hash"
                ))
            })?;
            let dep_resolution =
                find_dependency_version(&root, dep_module, dep_hash, target, visiting)?;
            dependencies.push(ActiveArtifactDependency {
                module_id: dep_resolution.identity.module_id.clone(),
                active_version: dep_resolution.identity.active_version.clone(),
                target_triple: dep_resolution.identity.target_triple.clone(),
                artifact_hash: dep_resolution.identity.artifact_hash.clone(),
                public_api_hash: dep_resolution.identity.public_api_hash.clone(),
                source_commit: dep_resolution.identity.source_commit.clone(),
            });
            dependency_resolutions.push(dep_resolution);
        }
    }

    let identity = ActiveArtifactIdentity {
        module_id: module_id.to_string(),
        active_version: version.to_string(),
        target_triple: target.to_string(),
        producer_rustc_version,
        artifact_hash: recorded_artifact_hash.to_string(),
        public_api_hash: recorded_public_api_hash.to_string(),
        source_commit,
        dependencies,
    };
    let identity_value = serde_json::to_value(&identity)
        .map_err(|e| ActiveLinkError::ManifestInvalid(format!("serialize identity: {e}")))?;
    let manifest_hash = sha256_hex(canonical(&identity_value).as_bytes());
    let mut resolution = ActiveArtifactResolution {
        manifest_hash,
        artifact_root: version_dir.clone(),
        rlib_paths,
        identity,
        dependency_resolutions,
        link_flags: Vec::new(),
    };
    resolution.link_flags = emit_link_flags(&resolution);
    Ok(resolution)
}
