//! OpenCode Zen client-identity headers required by the upstream free tier.
//!
//! The free-tier gate accepts the OpenCode client protocol only when the
//! session and request identifiers follow the repository's
//! `Identifier.descending` and `Identifier.ascending` encodings. Generate the
//! values at the transport-attempt boundary so retries and probes receive
//! fresh identifiers without putting control state into the business payload.

use provider_compat_core::opencode_zen_tcm::PROFILE;
use std::collections::hash_map::RandomState;
use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const OPENCODE_ID_ALPHABET: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
static OPENCODE_ID_STATE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
enum IdentifierOrder {
    Ascending,
    Descending,
}

/// Replace the configured OpenCode Zen session/request placeholders with
/// fresh values for the declared private compatibility profile.
///
/// The caller passes the already selected Target attributes. This function
/// never reads deployment provider identity, configuration, or business
/// payload.
pub fn stamp_opencode_zen_dynamic_request_headers(
    provider_type: &str,
    compatibility_profile: Option<&str>,
    headers: &mut BTreeMap<String, String>,
) {
    if provider_type != "openai_chat"
        || !compatibility_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(PROFILE))
    {
        return;
    }

    headers.retain(|name, _| {
        !name.eq_ignore_ascii_case("x-opencode-session")
            && !name.eq_ignore_ascii_case("x-opencode-request")
    });
    headers.insert(
        "x-opencode-session".to_string(),
        opencode_zen_identifier("ses", IdentifierOrder::Descending),
    );
    headers.insert(
        "x-opencode-request".to_string(),
        opencode_zen_identifier("msg", IdentifierOrder::Ascending),
    );
}

fn opencode_zen_identifier(prefix: &str, order: IdentifierOrder) -> String {
    let current = next_identifier_value(now_epoch_ms());
    let mut identifier = format!("{prefix}_{}", encode_time(current, order));
    let mut random_state = random_seed();
    for _ in 0..14 {
        random_state = splitmix64(random_state);
        identifier.push(OPENCODE_ID_ALPHABET[(random_state % 62) as usize] as char);
    }
    identifier
}

fn encode_time(current: u64, order: IdentifierOrder) -> String {
    let value = match order {
        IdentifierOrder::Ascending => current,
        IdentifierOrder::Descending => !current,
    };
    let mut time = String::with_capacity(12);
    for index in 0..6 {
        let shift = 40 - (index * 8);
        time.push_str(&format!("{:02x}", (value >> shift) & 0xff));
    }
    time
}

fn next_identifier_value(now_ms: u64) -> u64 {
    let mut observed = OPENCODE_ID_STATE.load(Ordering::Relaxed);
    loop {
        let last_ms = observed >> 12;
        let counter = observed & 0xfff;
        let (effective_ms, next_counter) = if now_ms > last_ms {
            (now_ms, 1)
        } else if counter >= 0xfff {
            (last_ms.saturating_add(1), 1)
        } else {
            (last_ms, counter + 1)
        };
        let next = (effective_ms << 12) | next_counter;
        match OPENCODE_ID_STATE.compare_exchange_weak(
            observed,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return next,
            Err(actual) => observed = actual,
        }
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn random_seed() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    now_epoch_ms().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    OPENCODE_ID_STATE.load(Ordering::Relaxed).hash(&mut hasher);
    hasher.finish()
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut result = value;
    result = (result ^ (result >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    result = (result ^ (result >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    result ^ (result >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_direction_matches_opencode_schema() {
        let current = 0x0000_0123_4567_89ab_u64;
        assert_ne!(
            encode_time(current, IdentifierOrder::Ascending),
            encode_time(current, IdentifierOrder::Descending),
        );
        assert_eq!(
            encode_time(current, IdentifierOrder::Descending),
            encode_time(!current, IdentifierOrder::Ascending),
        );
    }

    #[test]
    fn stamp_overwrites_static_headers_and_changes_values() {
        let mut first = BTreeMap::from([
            ("x-opencode-session".to_string(), "ses_static".to_string()),
            ("X-OpenCode-Request".to_string(), "msg_static".to_string()),
        ]);
        stamp_opencode_zen_dynamic_request_headers("openai_chat", Some(PROFILE), &mut first);

        assert_eq!(first.len(), 2);
        let first_session = first.get("x-opencode-session").expect("session header");
        let first_request = first.get("x-opencode-request").expect("request header");
        assert_valid_identifier(first_session, "ses_");
        assert_valid_identifier(first_request, "msg_");
        assert_ne!(first_session, first_request);

        let mut second = BTreeMap::new();
        stamp_opencode_zen_dynamic_request_headers("openai_chat", Some(PROFILE), &mut second);
        assert_ne!(
            first_session,
            second.get("x-opencode-session").expect("second session")
        );
        assert_ne!(
            first_request,
            second.get("x-opencode-request").expect("second request")
        );
    }

    #[test]
    fn stamp_is_scoped_to_opencode_chat_profile() {
        let mut other_profile =
            BTreeMap::from([("x-opencode-session".to_string(), "ses_static".to_string())]);
        stamp_opencode_zen_dynamic_request_headers(
            "openai_chat",
            Some("chat:other"),
            &mut other_profile,
        );
        assert_eq!(
            other_profile.get("x-opencode-session").expect("session"),
            "ses_static"
        );

        let mut other_protocol =
            BTreeMap::from([("x-opencode-session".to_string(), "ses_static".to_string())]);
        stamp_opencode_zen_dynamic_request_headers("responses", Some(PROFILE), &mut other_protocol);
        assert_eq!(
            other_protocol.get("x-opencode-session").expect("session"),
            "ses_static"
        );
    }

    fn assert_valid_identifier(value: &str, prefix: &str) {
        assert!(value.starts_with(prefix));
        assert_eq!(value.len(), 30);
        assert!(value[4..16]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)));
        assert!(value[16..].chars().all(|ch| ch.is_ascii_alphanumeric()));
    }
}
