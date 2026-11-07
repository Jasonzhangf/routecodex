use super::*;

// Request probe/wait/admission tests were retired with those APIs. Public
// held-probe/default tests cover request independence; Provider lifecycle tests
// own recovery cadence. Keep exact request failure identity coverage here.
#[test]
fn request_local_provider_failure_excludes_only_failed_candidate() {
    let scope = "request_local_provider_exclusion";
    let mut manifest = global_pool_alive_manifest(scope);
    let primary = manifest.providers.get_mut("first").expect("first provider");
    let mut key2 = primary.auth.entries[0].clone();
    key2.alias = "key2".to_string();
    primary.auth.entries.push(key2);

    let group = manifest
        .route_groups
        .get_mut(scope)
        .expect("request-local provider exclusion group");
    for pool in group.pools.values_mut() {
        for target in &mut pool.targets {
            if target.provider.as_deref() == Some("first") {
                target.key = None;
                target.priority = Some(2);
            } else {
                target.priority = Some(1);
            }
        }
    }

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("first provider must be selectable before failure"),
    };
    let failed_key = selected.candidate.auth_alias.clone();
    let excluded = BTreeSet::from([v3_relay_provider_candidate_key(&selected.candidate)]);
    let V3RelayProviderTargetResolution::Selected(selected) =
        resolve_target(&manifest, scope, &excluded, &health)
    else {
        panic!("the sibling key must remain selectable");
    };
    assert_eq!(selected.candidate.provider_id, "first");
    assert_ne!(selected.candidate.auth_alias, failed_key);
}

#[test]
fn request_local_exclusion_identity_preserves_sibling_interface() {
    let default_key = v3_relay_provider_candidate_key_parts_for_interface(
        "primary",
        "default",
        Some("key1"),
        Some("gpt-test"),
    );
    let sibling_key = v3_relay_provider_candidate_key_parts_for_interface(
        "primary",
        "sibling",
        Some("key1"),
        Some("gpt-test"),
    );
    assert_ne!(default_key, sibling_key);
    let excluded = BTreeSet::from([default_key]);
    assert!(!excluded.contains(&sibling_key));
}
