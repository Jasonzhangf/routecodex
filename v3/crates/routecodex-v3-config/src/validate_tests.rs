#[cfg(test)]
mod dev_sample_default_tests {
    use super::super::*;

    #[test]
    fn config_compilation_does_not_authorize_codex_samples() {
        let manifest = compile_debug(V3DebugAuthoringConfig {
            codex_samples: None,
            ..V3DebugAuthoringConfig::default()
        })
        .unwrap();
        assert!(!manifest.codex_samples);
    }
}

#[cfg(test)]
mod compatibility_profile_default_tests {
    use super::super::resolve_v3_native_provider_default_compatibility_profile;

    #[test]
    fn cc_sol_defaults_to_thinking_tag_response_compat() {
        assert_eq!(
            resolve_v3_native_provider_default_compatibility_profile("cc-sol").as_deref(),
            Some("responses:thinking-tags")
        );
    }
}

#[cfg(test)]
mod secret_file_compile_tests {
    use super::super::*;
    use std::fs;

    fn authoring_with(entry: V3ProviderAuthEntryAuthoringConfig) -> V3ProviderAuthAuthoringConfig {
        V3ProviderAuthAuthoringConfig {
            auth_type: V3ProviderAuthType::ApiKey,
            selection: V3SelectionPolicy::default(),
            entries: vec![entry],
        }
    }

    #[test]
    fn compile_auth_validates_secret_file_key_at_config_time() {
        let dir = std::env::temp_dir().join(format!(
            "rcc-secret-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("secrets.conf");
        fs::write(&file, "opencode-go.key1 = \"sk-one\"\n").unwrap();
        let file_str = file.display().to_string();

        let ok = compile_auth(
            "p",
            authoring_with(V3ProviderAuthEntryAuthoringConfig {
                alias: "key1".to_string(),
                env: None,
                token_file: None,
                api_key: None,
                secret_file: Some(file_str.clone()),
                secret_key: Some("opencode-go.key1".to_string()),
                priority: None,
                weight: None,
            }),
        )
        .unwrap();
        assert_eq!(
            ok.entries[0].secret_file.as_deref(),
            Some(file_str.as_str())
        );
        assert_eq!(
            ok.entries[0].secret_key.as_deref(),
            Some("opencode-go.key1")
        );

        let err = compile_auth(
            "p",
            authoring_with(V3ProviderAuthEntryAuthoringConfig {
                alias: "key1".to_string(),
                env: None,
                token_file: None,
                api_key: None,
                secret_file: Some(file_str),
                secret_key: Some("missing.key".to_string()),
                priority: None,
                weight: None,
            }),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("secret_file validation failed"),
            "{err}"
        );

        let pair_err = compile_auth(
            "p",
            authoring_with(V3ProviderAuthEntryAuthoringConfig {
                alias: "key1".to_string(),
                env: None,
                token_file: None,
                api_key: None,
                secret_file: Some("x".to_string()),
                secret_key: None,
                priority: None,
                weight: None,
            }),
        )
        .unwrap_err();
        assert!(
            pair_err.to_string().contains("declared together"),
            "{pair_err}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
