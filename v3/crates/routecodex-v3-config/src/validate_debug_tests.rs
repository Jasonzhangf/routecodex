use crate::types::V3DebugAuthoringConfig;
use crate::validate::compile_debug;

#[test]
fn config_compilation_preserves_codex_sample_authorization() {
    let manifest = compile_debug(V3DebugAuthoringConfig {
        codex_samples: Some(true),
        ..V3DebugAuthoringConfig::default()
    })
    .unwrap();
    assert!(manifest.codex_samples);
}
