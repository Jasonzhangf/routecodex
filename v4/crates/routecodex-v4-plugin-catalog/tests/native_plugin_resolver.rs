use routecodex_v4_plugin_catalog::{NativePluginResolver, ResolverError};
use routecodex_v4_plugin_contract::{
    NativePlugin, PluginConfig, PluginContext, PluginFailure, PluginIdentity, PluginOutcome,
};

struct TestPlugin(PluginIdentity);

impl NativePlugin for TestPlugin {
    fn identity(&self) -> &PluginIdentity {
        &self.0
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
fn resolver_binds_exact_identity_and_rejects_unknown_identity() {
    let identity = PluginIdentity::try_new("v4.test.native", "1.0.0", "sha256:artifact").unwrap();
    let mut resolver = NativePluginResolver::new();
    resolver
        .register(Box::new(TestPlugin(identity.clone())))
        .unwrap();
    assert!(resolver.resolve(&identity).is_ok());
    let unknown = PluginIdentity::try_new("v4.test.unknown", "1.0.0", "sha256:artifact").unwrap();
    assert!(matches!(
        resolver.resolve(&unknown),
        Err(ResolverError::UnknownIdentity(_))
    ));
}

#[test]
fn resolver_rejects_identity_collision() {
    let identity = PluginIdentity::try_new("v4.test.native", "1.0.0", "sha256:artifact").unwrap();
    let mut resolver = NativePluginResolver::new();
    resolver
        .register(Box::new(TestPlugin(identity.clone())))
        .unwrap();
    assert!(matches!(
        resolver.register(Box::new(TestPlugin(identity))),
        Err(ResolverError::DuplicateIdentity(_))
    ));
}
