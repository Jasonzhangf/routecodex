use std::process::Command;

#[test]
fn rccv3_hooksd_exposes_readiness_protocol_with_once_flag() {
    let output = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--once")
        .output()
        .expect("rccv3-hooksd should be runnable from the test binary");
    assert!(output.status.success(), "{output:?}");

    let readiness: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("sidecar readiness must be JSON");
    assert_eq!(readiness["protocol"], "rcc-hooks-sidecar/v1");
    assert_eq!(readiness["ready"], true);
}
