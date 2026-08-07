use serde_json::Value;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=ROUTECODEX_BUILD_VERSION");

    let version = explicit_build_version().unwrap_or_else(source_package_version);
    println!("cargo:rustc-env=ROUTECODEX_BUILD_VERSION={version}");
}

fn explicit_build_version() -> Option<String> {
    std::env::var("ROUTECODEX_BUILD_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn source_package_version() -> String {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR must identify the config crate"),
    );
    let package_json = manifest_dir.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());

    read_package_version(&package_json).unwrap_or_else(|message| panic!("{message}"))
}

fn read_package_version(package_json: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(package_json)
        .map_err(|error| format!("failed to read {}: {error}", package_json.display()))?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", package_json.display()))?;
    parsed
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "{} must contain a non-empty version",
                package_json.display()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::read_package_version;

    #[test]
    fn package_version_parser_requires_non_empty_string_version() {
        let root =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../package.json");
        assert!(read_package_version(&root).is_ok());
    }
}
