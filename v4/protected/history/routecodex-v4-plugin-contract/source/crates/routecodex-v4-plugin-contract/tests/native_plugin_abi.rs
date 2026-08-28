use routecodex_v4_plugin_contract::{
    NativePlugin, PluginConfig, PluginContext, PluginFailure, PluginIdentity, PluginOutcome,
};

struct TestPlugin {
    identity: PluginIdentity,
}

impl NativePlugin for TestPlugin {
    fn identity(&self) -> &PluginIdentity {
        &self.identity
    }

    fn execute(
        &self,
        _context: &PluginContext,
        _config: &PluginConfig,
    ) -> Result<PluginOutcome, PluginFailure> {
        Ok(PluginOutcome::Continue)
    }
}

#[test]
fn native_plugin_abi_exposes_typed_identity_context_config_and_outcome() {
    let plugin = TestPlugin {
        identity: PluginIdentity::try_new("v4.test.native", "1.0.0", "sha256:artifact").unwrap(),
    };
    let context = PluginContext::new("node-01", "scope-01");
    let config = PluginConfig::empty();
    assert_eq!(plugin.identity().plugin_id, "v4.test.native");
    assert_eq!(
        plugin.execute(&context, &config),
        Ok(PluginOutcome::Continue)
    );
}

#[test]
fn native_plugin_identity_rejects_missing_fields() {
    assert!(PluginIdentity::try_new("", "1.0.0", "sha256:artifact").is_err());
    assert!(PluginIdentity::try_new("v4.test.native", "", "sha256:artifact").is_err());
    assert!(PluginIdentity::try_new("v4.test.native", "1.0.0", "").is_err());
}
