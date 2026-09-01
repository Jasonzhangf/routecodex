//! P1-02 regression: the bridge is the one native plugin ABI.

use routecodex_v4_cordis_bridge::{ExecCtx, PluginHandle};
use serde_json::Value;

struct CapabilityHandle;

impl PluginHandle for CapabilityHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let _data = ctx.read_data();
        ctx.write_data(Value::Null)
            .map_err(|error| error.to_string())?;
        let _control = ctx
            .read_control_resource("v4.control.metadata_center")
            .map_err(|error| error.to_string())?;
        ctx.write_control_resource("v4.control.metadata_center", Value::Null)
            .map_err(|error| error.to_string())
    }
}

fn accepts_bridge_abi(_handle: &dyn PluginHandle, _ctx: &mut ExecCtx<'_>) {}

#[test]
fn bridge_handle_abi_carries_frame_data_effects_and_scoped_control() {
    let _ = CapabilityHandle;
    let _ = accepts_bridge_abi;
}
