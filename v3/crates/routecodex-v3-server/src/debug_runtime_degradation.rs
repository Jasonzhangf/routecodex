//! Optional debug-runtime degradation at aggregate-server startup.
//!
//! Debug is never business truth. A configured debug log sink that cannot be
//! opened must not stop the aggregate server, so the failure is recorded on the
//! runtime and the sink is reported unavailable instead of as working.

use routecodex_v3_config::V3DebugManifest;
use routecodex_v3_debug::V3DebugRuntime;

/// Build the debug runtime without letting its optional log sink stop the
/// aggregate server.
///
/// The runtime is rebuilt with that sink removed and the reason is recorded on
/// the runtime, which keeps the sink explicitly unavailable instead of
/// reporting a working one. No substitute sink is created, and every other
/// debug setting is preserved.
pub(crate) fn build_v3_debug_runtime_degrading_optional_log_sink(
    debug_manifest: &V3DebugManifest,
) -> Result<V3DebugRuntime, std::io::Error> {
    match crate::build_v3_debug_runtime_from_manifest(debug_manifest) {
        Ok(debug) => Ok(debug),
        Err(error) => {
            let mut without_log_file = debug_manifest.clone();
            without_log_file.log_file = None;
            // Opening the configured sink is the only fallible step of the debug
            // runtime, so this sink-free rebuild cannot fail.
            let mut debug = crate::build_v3_debug_runtime_from_manifest(&without_log_file)
                .map_err(std::io::Error::other)?;
            debug.mark_log_sink_unavailable(format!(
                "debug log sink {} unavailable: {error}",
                debug_manifest
                    .log_file
                    .as_deref()
                    .unwrap_or("<unconfigured>")
            ));
            eprintln!(
                "V3 debug log sink unavailable: {error}; continuing without the debug log file"
            );
            Ok(debug)
        }
    }
}
