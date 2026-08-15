use routecodex_v4_build_link::error::ActiveLinkError;
use routecodex_v4_build_link::identity::recompute_artifact_hash;
use routecodex_v4_build_link::resolver::{
    assert_outside_active, emit_link_flags, host_triple, resolve,
};
use routecodex_v4_build_link::IndexBuilder;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Hermetic fixture root: byte copies of the frozen base-node/edge/control/
/// error Active artifacts plus their tracked freeze/promotion/review/evidence
/// records.
/// The fixture keeps CI green without depending on gitignored `active/lib`.
fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests/resources/active-link-fixture")
        .canonicalize()
        .expect("active-link fixture root")
}

fn copy_dir_all(source: &Path, target: &Path) {
    fs::create_dir_all(target).expect("create temp target");
    for entry in fs::read_dir(source).expect("read source") {
        let entry = entry.expect("read dir entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_dir_all(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).expect("copy fixture file");
        }
    }
}

fn temp_fixture(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "v4-active-link-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    copy_dir_all(&fixture_root(), &base);
    base
}

#[test]
fn positive_frozen_base_node_active_identity_resolves() {
    let host = host_triple().expect("rustc host");
    let resolution = resolve(
        &fixture_root(),
        "routecodex-v4-base-node",
        "active-v1",
        &host,
    )
    .expect("frozen base-node Active artifact must resolve");
    assert_eq!(resolution.identity.module_id, "routecodex-v4-base-node");
    assert_eq!(resolution.identity.active_version, "active-v1");
    assert_eq!(
        resolution.identity.artifact_hash,
        "sha256:036daf4575cf81288e72a36e7a65a17854167dd6fa8cfdeb164b4506b595e4c4"
    );
    assert_eq!(
        resolution.identity.public_api_hash,
        "sha256:95f9248e0568946c686d9e17c809dfb49ad25ba002ed90709102d3f9f7f490f8"
    );
    assert_eq!(resolution.identity.source_commit, "fac43e278");
    assert!(resolution.identity.dependencies.is_empty());
    assert_eq!(
        resolution.rlib_paths.len(),
        1,
        "base-node Active surface must expose one rlib"
    );
    assert!(!resolution.link_flags.is_empty());
    assert!(
        resolution
            .link_flags
            .iter()
            .any(|flag| flag.starts_with("--extern routecodex_v4_base_node=")),
        "link flags must carry the base-node extern flag"
    );
}

#[test]
fn positive_edge_active_identity_resolves_with_dependency_closure() {
    let host = host_triple().expect("rustc host");
    let resolution = resolve(&fixture_root(), "routecodex-v4-edge", "active-v2", &host)
        .expect("frozen edge Active artifact must resolve");
    assert_eq!(resolution.identity.module_id, "routecodex-v4-edge");
    assert_eq!(
        resolution.identity.artifact_hash,
        "sha256:59078a62b2b1f1b94fa82d749b6812e9f1a653c39acd66d88fe5b38a9a866593"
    );
    assert_eq!(resolution.identity.dependencies.len(), 1);
    assert_eq!(
        resolution.identity.dependencies[0].module_id,
        "routecodex-v4-base-node"
    );
    assert_eq!(
        resolution.identity.dependencies[0].active_version,
        "active-v1"
    );
    assert_eq!(resolution.dependency_resolutions.len(), 1);
    assert_eq!(emit_link_flags(&resolution).len(), 2);
}

#[test]
fn positive_control_active_identity_resolves_with_dependency_closure() {
    let host = host_triple().expect("rustc host");
    let resolution = resolve(&fixture_root(), "routecodex-v4-control", "active-v2", &host)
        .expect("frozen control Active artifact must resolve");
    assert_eq!(resolution.identity.module_id, "routecodex-v4-control");
    assert_eq!(
        resolution.identity.artifact_hash,
        "sha256:bf6b8e426f5bda1962b5c0c4b82bde1be090294eed5e44bbfdc49d7cdc0e0103"
    );
    assert_eq!(resolution.identity.dependencies.len(), 1);
    assert_eq!(
        resolution.identity.dependencies[0].module_id,
        "routecodex-v4-base-node"
    );
    assert_eq!(
        resolution.identity.dependencies[0].active_version,
        "active-v1"
    );
    assert_eq!(resolution.dependency_resolutions.len(), 1);
    assert_eq!(emit_link_flags(&resolution).len(), 2);
}

#[test]
fn positive_error_active_identity_resolves_with_dependency_closure() {
    let host = host_triple().expect("rustc host");
    let resolution = resolve(&fixture_root(), "routecodex-v4-error", "active-v3", &host)
        .expect("frozen error Active artifact must resolve");
    assert_eq!(resolution.identity.module_id, "routecodex-v4-error");
    assert_eq!(
        resolution.identity.artifact_hash,
        "sha256:c26ccfc3ee6c847b1b4b2f812b72071a20df81f98fe40e60d457c41b3aed5d3f"
    );
    assert_eq!(resolution.identity.dependencies.len(), 1);
    assert_eq!(
        resolution.identity.dependencies[0].module_id,
        "routecodex-v4-base-node"
    );
    assert_eq!(
        resolution.identity.dependencies[0].active_version,
        "active-v1"
    );
    assert_eq!(resolution.dependency_resolutions.len(), 1);
    assert_eq!(emit_link_flags(&resolution).len(), 2);
}

#[test]
fn negative_missing_active_version_fails_fast() {
    let host = host_triple().expect("rustc host");
    let error = resolve(
        &fixture_root(),
        "routecodex-v4-base-node",
        "active-v9",
        &host,
    )
    .expect_err("missing Active version must fail");
    assert!(matches!(error, ActiveLinkError::ArtifactMissing(_)));
}

#[test]
fn negative_target_mismatch_fails_fast() {
    let error = resolve(
        &fixture_root(),
        "routecodex-v4-base-node",
        "active-v1",
        "x86_64-pc-windows-msvc",
    )
    .expect_err("cross-target resolution must fail");
    assert!(matches!(error, ActiveLinkError::TargetMismatch(_)));
}

#[test]
fn negative_rustc_producer_mismatch_fails_fast() {
    let host = host_triple().expect("rustc host");
    let mismatched_root = temp_fixture("rustc-mismatch");
    let freeze_file =
        mismatched_root.join(".appsdk/records/freeze-record-routecodex-v4-base-node.json");
    let mut freeze: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&freeze_file).expect("read freeze record"))
            .expect("parse freeze record");
    freeze["rustc_version"] = serde_json::json!("0.0.0-mismatch");
    fs::write(
        &freeze_file,
        serde_json::to_string_pretty(&freeze).expect("serialize freeze record"),
    )
    .expect("write mismatched freeze record");
    let error = resolve(
        &mismatched_root,
        "routecodex-v4-base-node",
        "active-v1",
        &host,
    )
    .expect_err("producer rustc mismatch must fail before link flags");
    assert!(matches!(error, ActiveLinkError::RustcMismatch(_)));
}

#[test]
fn negative_public_api_hash_tamper_fails_fast() {
    let host = host_triple().expect("rustc host");
    let tampered_root = temp_fixture("public-api-tamper");
    let artifact_file =
        tampered_root.join("active/lib/routecodex-v4-base-node/active-v1/artifact.json");
    let mut artifact: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&artifact_file).expect("read artifact"))
            .expect("parse artifact");
    artifact["public_api_hash"] = serde_json::json!("sha256:tampered-public-api-hash");
    artifact["artifact_hash"] = serde_json::json!(
        recompute_artifact_hash(&artifact).expect("recompute tampered artifact hash")
    );
    fs::write(
        &artifact_file,
        serde_json::to_string_pretty(&artifact).expect("serialize tampered artifact"),
    )
    .expect("write tampered artifact");
    let error = resolve(
        &tampered_root,
        "routecodex-v4-base-node",
        "active-v1",
        &host,
    )
    .expect_err("tampered public API hash record must fail");
    assert!(matches!(error, ActiveLinkError::PublicApiHashMismatch(_)));
}

#[test]
fn negative_stale_record_fails_fast() {
    let host = host_triple().expect("rustc host");
    let error = resolve(&fixture_root(), "routecodex-v4-config", "active-v1", &host)
        .expect_err("mutable module without freeze record must fail");
    assert!(matches!(error, ActiveLinkError::StaleOrMissingRecord(_)));
}

#[test]
fn negative_dependency_closure_mismatch_fails_fast() {
    let host = host_triple().expect("rustc host");
    let broken_root = temp_fixture("dep-missing");
    fs::remove_dir_all(broken_root.join("active/lib/routecodex-v4-base-node"))
        .expect("remove base-node fixture copy");
    let error = resolve(&broken_root, "routecodex-v4-edge", "active-v2", &host)
        .expect_err("dependency hash swap must fail");
    assert!(matches!(
        error,
        ActiveLinkError::DependencyClosureMismatch(_)
    ));
}

#[test]
fn negative_error_classify_without_witness_compile_fails() {
    // Hermetic negative gate: `ErrorChain::classify` must not be callable
    // without the mandatory single-use `ClassifyAuditWitness`. The compile
    // surface owner is the resolver, so the negative assertion lives here as a
    // rustc gate against the frozen error Active artifact; the l2 regression
    // locks the positive witness-bearing call shape.
    let fixture = fixture_root();
    let base_rlib = fixture
        .join("active/lib/routecodex-v4-base-node/active-v1/lib/libroutecodex_v4_base_node.rlib");
    let error_rlib =
        fixture.join("active/lib/routecodex-v4-error/active-v3/lib/libroutecodex_v4_error.rlib");
    assert!(base_rlib.is_file(), "fixture base-node rlib missing");
    assert!(error_rlib.is_file(), "fixture error rlib missing");
    let dir = std::env::temp_dir().join(format!(
        "v4-error-compile-gate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("create compile-gate temp dir");
    let bad = dir.join("bad.rs");
    fs::write(
        &bad,
        "use routecodex_v4_base_node::Scope;\n\
         use routecodex_v4_error::ErrorChain;\n\
         fn main() {\n\
             let mut chain = ErrorChain::new(Scope::new(\"r\", \"p\", 1, \"s\", \"c\"));\n\
             chain.classify();\n\
         }\n",
    )
    .expect("write negative snippet");
    let negative = Command::new("rustc")
        .arg("--edition=2021")
        .arg(&bad)
        .arg("--extern")
        .arg(format!("routecodex_v4_base_node={}", base_rlib.display()))
        .arg("--extern")
        .arg(format!("routecodex_v4_error={}", error_rlib.display()))
        .arg("-o")
        .arg(dir.join("bad"))
        .output()
        .expect("spawn rustc");
    assert!(
        !negative.status.success(),
        "classify without witness must not compile:\n{}",
        String::from_utf8_lossy(&negative.stderr)
    );
    let good = dir.join("good.rs");
    fs::write(
        &good,
        "use routecodex_v4_base_node::Scope;\n\
         use routecodex_v4_error::{ErrorCenter, ErrorChain};\n\
         fn main() {\n\
             let mut center = ErrorCenter::new(Scope::new(\"r\", \"p\", 1, \"s\", \"c\"));\n\
             let mut chain = ErrorChain::new(Scope::new(\"r\", \"p\", 1, \"s\", \"c\"));\n\
             let fact = chain.raise(\"timeout\", Some(\"sha256:p\"), Some(\"ctx\")).unwrap();\n\
             let captured = chain.capture().unwrap();\n\
             let witness = center.classify(captured).unwrap();\n\
             chain.classify(witness).unwrap();\n\
             let _ = fact;\n\
         }\n",
    )
    .expect("write positive snippet");
    let positive = Command::new("rustc")
        .arg("--edition=2021")
        .arg(&good)
        .arg("--extern")
        .arg(format!("routecodex_v4_base_node={}", base_rlib.display()))
        .arg("--extern")
        .arg(format!("routecodex_v4_error={}", error_rlib.display()))
        .arg("-o")
        .arg(dir.join("good"))
        .output()
        .expect("spawn rustc");
    assert!(
        positive.status.success(),
        "classify with witness must compile:\n{}",
        String::from_utf8_lossy(&positive.stderr)
    );
}

#[test]
fn negative_active_write_forbidden() {
    let error = assert_outside_active(
        &fixture_root(),
        &fixture_root().join("active/lib/routecodex-v4-base-node"),
    )
    .expect_err("write inside Active zone must fail");
    assert!(matches!(error, ActiveLinkError::ActiveWriteForbidden(_)));
}

#[test]
fn negative_active_write_forbidden_nonexistent_path() {
    let root = temp_fixture("active-write-nonexistent");
    let target = root.join("active/lib/routecodex-v4-base-node/escape-new.rlib");
    assert!(
        !target.exists(),
        "red test must use a not-yet-created target"
    );
    let error = assert_outside_active(&root, &target)
        .expect_err("write to a new file inside Active zone must fail");
    assert!(matches!(error, ActiveLinkError::ActiveWriteForbidden(_)));
}

#[test]
fn index_is_deterministic_and_drift_detected() {
    let root = temp_fixture("index-determinism");
    let first = IndexBuilder::build(&root, "fac43e278").expect("build index");
    let second = IndexBuilder::build(&root, "fac43e278").expect("rebuild index");
    assert_eq!(first.manifest_hash, second.manifest_hash);
    assert_eq!(first.entries.len(), 4);
    IndexBuilder::write(&root, &first).expect("write index");
    IndexBuilder::verify(&root, "fac43e278").expect("verify same-commit index");
    let drift = IndexBuilder::verify(&root, "different-commit").expect_err("drift must fail");
    assert!(matches!(drift, ActiveLinkError::ManifestInvalid(_)));
}
