use crate::types::V3DebugAuthoringConfig;
use crate::validate::compile_debug;

#[test]
fn config_compilation_does_not_authorize_codex_samples() {
    let manifest = compile_debug(V3DebugAuthoringConfig {
        codex_samples: None,
        ..V3DebugAuthoringConfig::default()
    })
    .unwrap();
    assert!(!manifest.codex_samples);
}
