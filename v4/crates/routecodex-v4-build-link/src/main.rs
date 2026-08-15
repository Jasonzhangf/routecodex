//! routecodex-v4-build-link CLI — the single V4 Active link surface owner.
//!
//! Subcommands:
//!   resolve         resolve one frozen Active artifact to its link surface
//!   emit-link-flags print rustc --extern flags for a resolved artifact
//!   gen-index       compile the deterministic Active index
//!   verify-index    re-derive and compare the on-disk Active index
//!   build-consumer  build a consumer lib via resolver-emitted rustc flags
//!   test-consumer   build and run a consumer regression via rustc flags

use routecodex_v4_build_link::resolver::assert_outside_active;
use routecodex_v4_build_link::resolver::{emit_link_flags, host_triple, resolve};
use routecodex_v4_build_link::resolver::{frozen_module_ids, source_dep_link_args};
use routecodex_v4_build_link::ActiveArtifactResolution;
use routecodex_v4_build_link::ActiveLinkError;
use routecodex_v4_build_link::IndexBuilder;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn fail(error: ActiveLinkError) -> ExitCode {
    eprintln!("{error}");
    ExitCode::from(1)
}

fn arg_value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| format!("missing required argument {name}"))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

/// `--source-deps <crate>[,<crate>...]` (repeatable): mutable workspace crates
/// linked through the resolver as dev-time rlibs. Frozen modules are rejected
/// by `source_dep_link_args`; only non-frozen V4 crates may be consumed this way.
fn parse_source_deps(args: &[String]) -> Result<Vec<String>, String> {
    let mut deps = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if arg != "--source-deps" {
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| "missing value for --source-deps".to_string())?;
        for part in value.split(',') {
            let part = part.trim();
            if !part.is_empty() {
                deps.push(part.to_string());
            }
        }
    }
    deps.sort();
    deps.dedup();
    Ok(deps)
}

fn root_from(args: &[String]) -> Result<PathBuf, String> {
    Ok(PathBuf::from(arg_value(args, "--root")?))
}

fn git_head(root: &Path) -> Result<String, ActiveLinkError> {
    let output = Command::new("git")
        .args(["-C", root.to_str().unwrap_or("."), "rev-parse", "HEAD"])
        .output()
        .map_err(|e| ActiveLinkError::ManifestInvalid(format!("git rev-parse HEAD: {e}")))?;
    if !output.status.success() {
        return Err(ActiveLinkError::ManifestInvalid(
            "git rev-parse HEAD failed; pass --commit explicitly".into(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn target_from(args: &[String]) -> Result<String, ActiveLinkError> {
    if let Some(index) = args.iter().position(|arg| arg == "--target") {
        args.get(index + 1)
            .cloned()
            .ok_or_else(|| ActiveLinkError::TargetMismatch("missing --target value".into()))
    } else {
        host_triple()
    }
}

fn module_active_version(root: &Path, module_id: &str) -> Result<String, ActiveLinkError> {
    let path = root
        .join(".appsdk/records")
        .join(format!("freeze-record-{module_id}.json"));
    let text = fs::read_to_string(&path).map_err(|e| {
        ActiveLinkError::StaleOrMissingRecord(format!("read {}: {e}", path.display()))
    })?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        ActiveLinkError::StaleOrMissingRecord(format!("parse {}: {e}", path.display()))
    })?;
    value
        .get("active_version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            ActiveLinkError::StaleOrMissingRecord(format!(
                "freeze record {module_id} missing active_version"
            ))
        })
}

fn resolve_dependencies(
    root: &Path,
    deps: &[String],
    target: &str,
) -> Result<Vec<ActiveArtifactResolution>, ActiveLinkError> {
    let mut resolutions = Vec::new();
    for dep in deps {
        let version = module_active_version(root, dep)?;
        resolutions.push(resolve(root, dep, &version, target)?);
    }
    Ok(resolutions)
}

fn run_rustc(args: &[String]) -> Result<(), ActiveLinkError> {
    let output = Command::new("rustc")
        .args(args)
        .output()
        .map_err(|e| ActiveLinkError::LinkFailed(format!("spawn rustc: {e}")))?;
    if !output.status.success() {
        return Err(ActiveLinkError::LinkFailed(format!(
            "rustc failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

/// `-L dependency=<dir>` search arguments for every rlib in the closure.
/// rustc requires transitive dependency rlibs to be on the search path in
/// addition to `--extern` for direct crates.
fn dependency_search_args(resolutions: &[ActiveArtifactResolution]) -> Vec<String> {
    let mut dirs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    fn walk(
        resolution: &ActiveArtifactResolution,
        dirs: &mut Vec<String>,
        seen: &mut std::collections::HashSet<String>,
    ) {
        for rlib in &resolution.rlib_paths {
            if let Some(parent) = rlib.parent() {
                let dir = parent.display().to_string();
                if seen.insert(dir.clone()) {
                    dirs.push(dir);
                }
            }
        }
        for dependency in &resolution.dependency_resolutions {
            walk(dependency, dirs, seen);
        }
    }
    for resolution in resolutions {
        walk(resolution, &mut dirs, &mut seen);
    }
    dirs.into_iter()
        .flat_map(|dir| ["-L".to_string(), format!("dependency={dir}")])
        .collect()
}

fn crate_name(module_id: &str) -> String {
    module_id.replace('-', "_")
}

/// `--extern <crate>=<rlib>` for every rlib of every dependency resolution.
fn extern_args(resolutions: &[ActiveArtifactResolution]) -> Vec<String> {
    let mut args = Vec::new();
    for resolution in resolutions {
        for rlib in &resolution.rlib_paths {
            args.push("--extern".to_string());
            args.push(format!(
                "{}={}",
                crate_name(&resolution.identity.module_id),
                rlib.display()
            ));
        }
    }
    args
}

/// Registry (non-path) dependency of a consumer manifest, e.g. serde/sha2.
/// These are not V4 module artifacts; the resolver builds them once into
/// `build-control/extern-deps` and links them as ordinary extern crates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExternalCrate {
    name: String,
    version: String,
    features: Vec<String>,
    default_features: bool,
}

fn parse_external_deps(consumer_dir: &Path) -> Result<Vec<ExternalCrate>, ActiveLinkError> {
    let manifest = consumer_dir.join("Cargo.toml");
    let text = fs::read_to_string(&manifest).map_err(|e| {
        ActiveLinkError::ManifestInvalid(format!("read {}: {e}", manifest.display()))
    })?;
    let value: toml::Value = toml::from_str(&text).map_err(|e| {
        ActiveLinkError::ManifestInvalid(format!("parse {}: {e}", manifest.display()))
    })?;
    let Some(table) = value.get("dependencies").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };
    let mut crates = Vec::new();
    for (name, spec) in table {
        match spec {
            toml::Value::String(version) => crates.push(ExternalCrate {
                name: name.clone(),
                version: version.clone(),
                features: Vec::new(),
                default_features: true,
            }),
            toml::Value::Table(dep) => {
                if dep.contains_key("path") {
                    // V4 module dependency: resolved exclusively via Active surface.
                    continue;
                }
                let version = dep
                    .get("version")
                    .and_then(toml::Value::as_str)
                    .ok_or_else(|| {
                        ActiveLinkError::ManifestInvalid(format!(
                            "{}: registry dependency missing version",
                            name
                        ))
                    })?;
                let features = dep
                    .get("features")
                    .and_then(toml::Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(toml::Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let default_features = dep
                    .get("default-features")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(true);
                crates.push(ExternalCrate {
                    name: name.clone(),
                    version: version.to_string(),
                    features,
                    default_features,
                });
            }
            _ => {
                return Err(ActiveLinkError::ManifestInvalid(format!(
                    "{}: unsupported dependency spec",
                    name
                )))
            }
        }
    }
    crates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(crates)
}

#[derive(Debug, Default)]
struct ExternalLink {
    extern_args: Vec<String>,
    search_args: Vec<String>,
}

/// Build registry dependencies of a consumer into a resolver-owned scratch
/// project (`build-control/extern-deps`) and return rustc link arguments.
fn build_external_deps(
    root: &Path,
    crates: &[ExternalCrate],
) -> Result<ExternalLink, ActiveLinkError> {
    if crates.is_empty() {
        return Ok(ExternalLink::default());
    }
    let scratch = root.join("build-control/extern-deps");
    fs::create_dir_all(&scratch)
        .map_err(|e| ActiveLinkError::LinkFailed(format!("create {}: {e}", scratch.display())))?;
    let mut manifest = String::from(
        "[package]\nname = \"routecodex-v4-extern-deps\"\nversion = \"0.0.0\"\nedition = \"2021\"\npublish = false\n\n[lib]\npath = \"src/lib.rs\"\n\n[workspace]\n\n[dependencies]\n",
    );
    for external in crates {
        manifest.push_str(&format!(
            "{} = {{ version = {:?}",
            external.name, external.version
        ));
        if !external.default_features {
            manifest.push_str(", default-features = false");
        }
        if !external.features.is_empty() {
            manifest.push_str(", features = [");
            for (index, feature) in external.features.iter().enumerate() {
                if index > 0 {
                    manifest.push_str(", ");
                }
                manifest.push_str(&format!("{:?}", feature));
            }
            manifest.push(']');
        }
        manifest.push_str(" }\n");
    }
    let manifest_path = scratch.join("Cargo.toml");
    fs::write(&manifest_path, manifest).map_err(|e| {
        ActiveLinkError::LinkFailed(format!("write {}: {e}", manifest_path.display()))
    })?;
    let lib_path = scratch.join("src/lib.rs");
    fs::create_dir_all(
        lib_path
            .parent()
            .ok_or_else(|| ActiveLinkError::LinkFailed("extern-deps src has no parent".into()))?,
    )
    .map_err(|e| ActiveLinkError::LinkFailed(format!("create {}: {e}", lib_path.display())))?;
    if !lib_path.is_file() {
        fs::write(&lib_path, "").map_err(|e| {
            ActiveLinkError::LinkFailed(format!("write {}: {e}", lib_path.display()))
        })?;
    }
    let output = Command::new("cargo")
        .args(["build", "--release", "--manifest-path"])
        .arg(&manifest_path)
        .output()
        .map_err(|e| ActiveLinkError::LinkFailed(format!("spawn cargo: {e}")))?;
    if !output.status.success() {
        return Err(ActiveLinkError::LinkFailed(format!(
            "extern deps build failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let deps_dir = scratch.join("target/release/deps");
    let mut extern_args = Vec::new();
    for external in crates {
        let rust_name = external.name.replace('-', "_");
        let mut candidates: Vec<PathBuf> = fs::read_dir(&deps_dir)
            .map_err(|e| ActiveLinkError::LinkFailed(format!("read {}: {e}", deps_dir.display())))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .map(|name| {
                        let name = name.to_string_lossy();
                        name.starts_with(&format!("lib{rust_name}-")) && name.ends_with(".rlib")
                    })
                    .unwrap_or(false)
            })
            .collect();
        candidates.sort();
        let rlib = candidates.last().ok_or_else(|| {
            ActiveLinkError::LinkFailed(format!(
                "no rlib for external crate {rust_name} in {}",
                deps_dir.display()
            ))
        })?;
        extern_args.push("--extern".to_string());
        extern_args.push(format!("{rust_name}={}", rlib.display()));
    }
    Ok(ExternalLink {
        extern_args,
        search_args: vec![
            "-L".to_string(),
            format!("dependency={}", deps_dir.display()),
        ],
    })
}

fn build_consumer(
    root: &Path,
    consumer: &str,
    deps: &[String],
    target: &str,
    out_override: Option<&Path>,
    external: &ExternalLink,
    source_args: &[String],
) -> Result<PathBuf, ActiveLinkError> {
    let dep_resolutions = resolve_dependencies(root, deps, target)?;
    let src = root.join("crates").join(consumer).join("src/lib.rs");
    if !src.is_file() {
        return Err(ActiveLinkError::LinkFailed(format!(
            "consumer source {} missing",
            src.display()
        )));
    }
    let out = match out_override {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) => root.join(path),
        None => root
            .join("build-control")
            .join(consumer)
            .join(format!("lib{}.rlib", crate_name(consumer))),
    };
    assert_outside_active(root, &out)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            ActiveLinkError::LinkFailed(format!("create {}: {e}", parent.display()))
        })?;
    }
    let mut rustc_args = vec![
        "--edition".to_string(),
        "2021".to_string(),
        "--crate-name".to_string(),
        crate_name(consumer),
        "--crate-type".to_string(),
        "lib".to_string(),
        src.to_str().unwrap_or("").to_string(),
    ];
    rustc_args.extend(extern_args(&dep_resolutions));
    rustc_args.extend(dependency_search_args(&dep_resolutions));
    rustc_args.extend(external.extern_args.iter().cloned());
    rustc_args.extend(external.search_args.iter().cloned());
    rustc_args.extend(source_args.iter().cloned());
    rustc_args.push("-o".to_string());
    rustc_args.push(out.to_str().unwrap_or("").to_string());
    run_rustc(&rustc_args)?;
    Ok(out)
}

fn test_consumer(
    root: &Path,
    consumer: &str,
    deps: &[String],
    target: &str,
    source_args: &[String],
) -> Result<(), ActiveLinkError> {
    let dep_resolutions = resolve_dependencies(root, deps, target)?;
    let external_crates = parse_external_deps(&root.join("crates").join(consumer))?;
    let external = build_external_deps(root, &external_crates)?;
    let consumer_lib = build_consumer(root, consumer, deps, target, None, &external, source_args)?;
    let tests_dir = root.join("crates").join(consumer).join("tests");
    let mut test_files = fs::read_dir(&tests_dir)
        .map_err(|e| ActiveLinkError::LinkFailed(format!("read {}: {e}", tests_dir.display())))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".rs"))
        .collect::<Vec<_>>();
    test_files.sort_by_key(|entry| entry.file_name());
    if test_files.is_empty() {
        return Err(ActiveLinkError::LinkFailed(format!(
            "no test sources in {}",
            tests_dir.display()
        )));
    }
    let out_dir = root.join("build-control").join(consumer);
    fs::create_dir_all(&out_dir)
        .map_err(|e| ActiveLinkError::LinkFailed(format!("create {}: {e}", out_dir.display())))?;
    for entry in test_files {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let stem = file_name.strip_suffix(".rs").unwrap_or(&file_name);
        let test_bin = out_dir.join(stem);
        let mut rustc_args = vec![
            "--edition".to_string(),
            "2021".to_string(),
            "--test".to_string(),
            path.to_str().unwrap_or("").to_string(),
            "--extern".to_string(),
            format!("{}={}", crate_name(consumer), consumer_lib.display()),
        ];
        rustc_args.extend(extern_args(&dep_resolutions));
        rustc_args.extend(dependency_search_args(&dep_resolutions));
        rustc_args.extend(external.extern_args.iter().cloned());
        rustc_args.extend(external.search_args.iter().cloned());
        rustc_args.extend(source_args.iter().cloned());
        rustc_args.push("-o".to_string());
        rustc_args.push(test_bin.to_str().unwrap_or("").to_string());
        run_rustc(&rustc_args)?;
        let run = Command::new(&test_bin)
            .output()
            .map_err(|e| ActiveLinkError::LinkFailed(format!("run {}: {e}", test_bin.display())))?;
        if !run.status.success() {
            return Err(ActiveLinkError::LinkFailed(format!(
                "{consumer} {file_name} regression failed:\nstdout: {}\nstderr: {}",
                String::from_utf8_lossy(&run.stdout),
                String::from_utf8_lossy(&run.stderr)
            )));
        }
        print!("{}", String::from_utf8_lossy(&run.stdout));
    }
    Ok(())
}

fn run(args: &[String]) -> Result<(), ActiveLinkError> {
    let Some(command) = args.first() else {
        eprintln!("usage: routecodex-v4-build-link <resolve|emit-link-flags|gen-index|verify-index|build-consumer|test-consumer> ...");
        return Err(ActiveLinkError::IdentityMissing("no subcommand".into()));
    };
    match command.as_str() {
        "resolve" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let module = arg_value(args, "--module").map_err(ActiveLinkError::IdentityMissing)?;
            let version = arg_value(args, "--version").map_err(ActiveLinkError::IdentityMissing)?;
            let target = target_from(args)?;
            let resolution = resolve(&root, &module, &version, &target)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resolution).map_err(|e| {
                    ActiveLinkError::ManifestInvalid(format!("serialize resolution: {e}"))
                })?
            );
            Ok(())
        }
        "emit-link-flags" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let module = arg_value(args, "--module").map_err(ActiveLinkError::IdentityMissing)?;
            let version = arg_value(args, "--version").map_err(ActiveLinkError::IdentityMissing)?;
            let target = target_from(args)?;
            let resolution = resolve(&root, &module, &version, &target)?;
            for flag in emit_link_flags(&resolution) {
                println!("{flag}");
            }
            Ok(())
        }
        "gen-index" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let commit = if let Some(index) = args.iter().position(|arg| arg == "--commit") {
                args.get(index + 1).cloned().ok_or_else(|| {
                    ActiveLinkError::ManifestInvalid("missing --commit value".into())
                })?
            } else {
                git_head(&root)?
            };
            let manifest = IndexBuilder::build(&root, &commit)?;
            let output = IndexBuilder::write(&root, &manifest)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&manifest).map_err(|e| {
                    ActiveLinkError::ManifestInvalid(format!("serialize index: {e}"))
                })?
            );
            println!("index written: {}", output.display());
            Ok(())
        }
        "verify-index" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let commit = if let Some(index) = args.iter().position(|arg| arg == "--commit") {
                args.get(index + 1).cloned().ok_or_else(|| {
                    ActiveLinkError::ManifestInvalid("missing --commit value".into())
                })?
            } else {
                git_head(&root)?
            };
            IndexBuilder::verify(&root, &commit)?;
            println!("V4_ACTIVE_INDEX_OK");
            Ok(())
        }
        "build-consumer" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let target = target_from(args)?;
            let consumer =
                arg_value(args, "--consumer").map_err(ActiveLinkError::IdentityMissing)?;
            let deps = arg_value(args, "--deps").map_err(ActiveLinkError::IdentityMissing)?;
            let deps = deps.split(',').map(str::to_string).collect::<Vec<_>>();
            let out_override = args
                .iter()
                .position(|arg| arg == "--out")
                .and_then(|index| args.get(index + 1))
                .map(PathBuf::from);
            let source_deps = parse_source_deps(args).map_err(ActiveLinkError::LinkFailed)?;
            let frozen = frozen_module_ids(&root)?;
            let source_args = source_dep_link_args_all(&root, &source_deps, &frozen)?;
            let external_crates = parse_external_deps(&root.join("crates").join(&consumer))?;
            let external = build_external_deps(&root, &external_crates)?;
            let out = build_consumer(
                &root,
                &consumer,
                &deps,
                &target,
                out_override.as_deref(),
                &external,
                &source_args,
            )?;
            println!(
                "{consumer} lib built via Active link surface: {}",
                out.display()
            );
            Ok(())
        }
        "test-consumer" => {
            let root = root_from(args).map_err(ActiveLinkError::ManifestInvalid)?;
            let target = target_from(args)?;
            let consumer =
                arg_value(args, "--consumer").map_err(ActiveLinkError::IdentityMissing)?;
            let deps = arg_value(args, "--deps").map_err(ActiveLinkError::IdentityMissing)?;
            let deps = deps.split(',').map(str::to_string).collect::<Vec<_>>();
            let source_deps = parse_source_deps(args).map_err(ActiveLinkError::LinkFailed)?;
            let frozen = frozen_module_ids(&root)?;
            let source_args = source_dep_link_args_all(&root, &source_deps, &frozen)?;
            test_consumer(&root, &consumer, &deps, &target, &source_args)
        }
        _ => {
            eprintln!("unknown command {command:?}");
            Err(ActiveLinkError::IdentityMissing(format!(
                "unknown command {command:?}"
            )))
        }
    }
}

/// Link arguments for every requested workspace source dependency. The loop
/// lives here so `build-consumer` and `test-consumer` share one resolution.
fn source_dep_link_args_all(
    root: &Path,
    names: &[String],
    frozen: &HashSet<String>,
) -> Result<Vec<String>, ActiveLinkError> {
    let mut args = Vec::new();
    for name in names {
        args.extend(source_dep_link_args(root, name, frozen)?);
    }
    Ok(args)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}
