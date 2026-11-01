//! Regression for the loopback port allocator shared by the V3 integration
//! tests. The pre-fix allocator returned whatever `bind("127.0.0.1:0")` reported
//! and dropped the listener, so it could hand the same port to two callers and
//! redden CI with a shared listen address / `Address already in use`.

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

use std::collections::HashSet;

#[test]
fn reserve_unique_port_skips_ports_that_were_already_handed_out() {
    let mut remaining = [41000_u16, 41000, 41000, 41001].into_iter();
    let mut candidates = move || remaining.next().expect("candidate port");
    let mut allocated = HashSet::new();

    let first = test_ports::reserve_unique_port(&mut candidates, &mut allocated);
    let second = test_ports::reserve_unique_port(&mut candidates, &mut allocated);

    assert_eq!(first, 41000, "first draw keeps the candidate port");
    assert_eq!(
        second, 41001,
        "a repeated candidate must be skipped, not handed out twice"
    );
    assert_eq!(allocated.len(), 2);
}
