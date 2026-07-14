use routecodex_v3_runtime::{
    compile_v3_hub_v1_static_registry, compile_v3_hub_v1_static_registry_from_config,
    V3HubHookImplementation, V3HubHookSlot, V3HubStartupError, V3_HUB_V1_HOOK_SLOT_COUNT,
};

#[test]
fn static_registry_is_closed_complete_and_deterministic() {
    let first = compile_v3_hub_v1_static_registry().expect("canonical registry");
    let second = compile_v3_hub_v1_static_registry().expect("canonical registry");
    assert_eq!(first.manifest(), second.manifest());
    assert_eq!(first.manifest().len(), V3_HUB_V1_HOOK_SLOT_COUNT);
    for slot in V3HubHookSlot::ALL {
        let hook = first.hook(slot).expect("every fixed slot registered");
        assert_eq!(
            hook.implementation(),
            V3HubHookImplementation::NotImplemented
        );
        assert!(hook.invoke().is_err(), "H1 branch must fail explicitly");
    }
}

#[test]
fn startup_rejects_missing_duplicate_unknown_and_incompatible_hooks() {
    let missing = compile_v3_hub_v1_static_registry().unwrap().manifest()[1..].to_vec();
    assert!(matches!(
        routecodex_v3_runtime::validate_v3_hub_v1_hook_manifest(&missing),
        Err(V3HubStartupError::MissingHook { .. })
    ));

    let canonical = compile_v3_hub_v1_static_registry().unwrap();
    let mut duplicate = canonical.manifest().to_vec();
    duplicate.push(duplicate[0]);
    assert!(matches!(
        routecodex_v3_runtime::validate_v3_hub_v1_hook_manifest(&duplicate),
        Err(V3HubStartupError::DuplicateHook { .. })
    ));

    let mut unknown = canonical.manifest().to_vec();
    unknown[0].hook_id = "hub_v1.unknown";
    assert!(matches!(
        routecodex_v3_runtime::validate_v3_hub_v1_hook_manifest(&unknown),
        Err(V3HubStartupError::UnknownHook { .. })
    ));

    let mut incompatible = canonical.manifest().to_vec();
    incompatible[0].output_node = "V3HubReqTarget06Resolved";
    assert!(matches!(
        routecodex_v3_runtime::validate_v3_hub_v1_hook_manifest(&incompatible),
        Err(V3HubStartupError::IncompatibleHook { .. })
    ));
}

#[test]
fn startup_compiles_config_manifest_against_callable_static_hooks() {
    let canonical = compile_v3_hub_v1_static_registry().unwrap();
    let manifest = routecodex_v3_config::V3HubV1Manifest {
        skeleton: "hub_v1".to_string(),
        entry_protocols: vec![
            "responses".to_string(),
            "anthropic".to_string(),
            "gemini".to_string(),
            "openai_chat".to_string(),
        ],
        hooks: canonical
            .manifest()
            .iter()
            .map(|hook| hook.hook_id.to_string())
            .collect(),
    };
    let compiled = compile_v3_hub_v1_static_registry_from_config(&manifest).unwrap();
    assert_eq!(compiled.manifest(), canonical.manifest());

    let mut invalid = manifest;
    invalid.hooks.swap(0, 1);
    assert!(matches!(
        compile_v3_hub_v1_static_registry_from_config(&invalid),
        Err(V3HubStartupError::ConfiguredManifest { .. })
    ));
}
