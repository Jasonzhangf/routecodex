//! L2 catalog admission for the M5 standard plugin library.
//!
//! Positive: every standard plugin (typed descriptor + canonical artifact and
//! contract bytes) registers into `PluginCatalog`; re-registration with the
//! same immutable identity is idempotent; dependency resolution is clean.
//! Negative: a flipped artifact/contract byte is rejected by hash mismatch,
//! and a different owner for the same plugin id is rejected as an owner
//! conflict. The catalog snapshot is never a business request input.

use routecodex_v4_plugin_catalog::{CatalogError, PluginCatalog};
use routecodex_v4_standard_plugins::{catalog_entry, register_standard_library, standard_plugins};

#[test]
fn positive_all_standard_plugins_register_into_catalog() {
    let mut catalog = PluginCatalog::new();
    let count = register_standard_library(&mut catalog).expect("standard library registers");
    let plugins = standard_plugins();
    assert_eq!(
        count,
        plugins.len(),
        "register count matches standard plugin count"
    );
    let snapshot = catalog.snapshot();
    assert_eq!(snapshot.entries().len(), plugins.len());
    for plugin in &plugins {
        assert!(
            snapshot
                .entries()
                .iter()
                .any(|entry| entry.plugin_id == plugin.descriptor.plugin_id),
            "catalog contains {}",
            plugin.descriptor.plugin_id
        );
    }
    catalog
        .resolve_dependencies()
        .expect("standard dependency graph resolves");
}

#[test]
fn positive_reregistration_with_same_identity_is_idempotent() {
    let mut catalog = PluginCatalog::new();
    register_standard_library(&mut catalog).expect("first registration");
    register_standard_library(&mut catalog).expect("idempotent re-registration");
    assert_eq!(catalog.snapshot().entries().len(), standard_plugins().len());
}

#[test]
fn negative_flipped_artifact_byte_is_rejected() {
    let plugins = standard_plugins();
    let plugin = plugins
        .first()
        .expect("standard library is not empty")
        .clone();
    let mut tampered = plugin.artifact_bytes.clone();
    tampered[0] ^= 0xff;
    let mut catalog = PluginCatalog::new();
    let error = catalog
        .register(catalog_entry(&plugin), &tampered, &plugin.contract_bytes)
        .expect_err("tampered artifact must fail");
    assert!(
        matches!(error, CatalogError::ArtifactHashMismatch { .. }),
        "got {error:?}"
    );
    assert!(catalog.snapshot().entries().is_empty());
}

#[test]
fn negative_flipped_contract_byte_is_rejected() {
    let plugins = standard_plugins();
    let plugin = plugins
        .first()
        .expect("standard library is not empty")
        .clone();
    let mut tampered = plugin.contract_bytes.clone();
    tampered[0] ^= 0xff;
    let mut catalog = PluginCatalog::new();
    let error = catalog
        .register(catalog_entry(&plugin), &plugin.artifact_bytes, &tampered)
        .expect_err("tampered contract must fail");
    assert!(
        matches!(error, CatalogError::ContractHashMismatch { .. }),
        "got {error:?}"
    );
    assert!(catalog.snapshot().entries().is_empty());
}

#[test]
fn negative_identity_drift_is_rejected() {
    let plugins = standard_plugins();
    let plugin = plugins
        .first()
        .expect("standard library is not empty")
        .clone();
    let mut catalog = PluginCatalog::new();
    catalog
        .register(
            catalog_entry(&plugin),
            &plugin.artifact_bytes,
            &plugin.contract_bytes,
        )
        .expect("initial registration");
    let mut drifted = catalog_entry(&plugin);
    drifted.owner = "another-owner".to_string();
    let error = catalog
        .register(drifted, &plugin.artifact_bytes, &plugin.contract_bytes)
        .expect_err("owner drift must conflict");
    assert!(
        matches!(error, CatalogError::DuplicateConflict { .. }),
        "got {error:?}"
    );
    assert_eq!(catalog.snapshot().entries().len(), 1);
}
