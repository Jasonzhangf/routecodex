use routecodex_v3_error::*;

fn source(status: u16, code: &str) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        code,
        "controlled Provider failure",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(code.into()),
            provider_id: Some("controlled".into()),
            upstream_request_id: None,
            message: None,
        },
    )
}

#[test]
fn typed_failures_choose_retry_or_reselection() {
    for (status, code, class) in [
        (
            429,
            "rate_limit",
            V3ActiveKeyFailureClass::RetryableDelivery,
        ),
        (
            500,
            "server_error",
            V3ActiveKeyFailureClass::RetryableDelivery,
        ),
        (
            503,
            "server_error",
            V3ActiveKeyFailureClass::RetryableDelivery,
        ),
        (
            401,
            "unauthorized",
            V3ActiveKeyFailureClass::NonretryableDelivery,
        ),
        (
            403,
            "permission_error",
            V3ActiveKeyFailureClass::NonretryableDelivery,
        ),
        (
            400,
            "invalid_request",
            V3ActiveKeyFailureClass::NonretryableDelivery,
        ),
        (
            422,
            "invalid_request",
            V3ActiveKeyFailureClass::NonretryableDelivery,
        ),
        (
            429,
            "insufficient_quota",
            V3ActiveKeyFailureClass::NonretryableDelivery,
        ),
    ] {
        let source = source(status, code);
        assert_eq!(classify_v3_active_key_failure(&source, true), class);
        assert_eq!(
            classify_v3_active_key_failure(&source, false),
            V3ActiveKeyFailureClass::Neutral
        );
        assert_eq!(
            plan_v3_active_key_recovery(class, false),
            V3ActiveKeyRecoveryAction::Reselect
        );
        assert_eq!(
            plan_v3_active_key_recovery(class, true),
            if class == V3ActiveKeyFailureClass::RetryableDelivery {
                V3ActiveKeyRecoveryAction::RetrySelectedActiveKey
            } else {
                V3ActiveKeyRecoveryAction::Reselect
            }
        );
    }
}

#[test]
fn transport_processing_and_client_causes_keep_their_distinct_dispositions() {
    let mut transport = source(502, "provider_transport_error");
    transport.external_error.as_mut().unwrap().kind = V3ExternalErrorKind::Transport;
    assert_eq!(
        classify_v3_active_key_failure(&transport, true),
        V3ActiveKeyFailureClass::RetryableDelivery
    );
    let processing = build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3ProviderResp14Raw",
        "provider_response_empty",
        "no accepted result after governance",
        V3InternalErrorCode::V3ProviderResp14Raw,
    );
    assert_eq!(
        classify_v3_active_key_failure(&processing, true),
        V3ActiveKeyFailureClass::NonretryableDelivery
    );
    assert_eq!(
        classify_v3_active_key_failure(&processing, false),
        V3ActiveKeyFailureClass::Neutral
    );
    for kind in [
        V3ErrorSourceKind::ClientDisconnect,
        V3ErrorSourceKind::InvalidRequest,
        V3ErrorSourceKind::SuccessControl,
        V3ErrorSourceKind::TargetPoolExhausted,
    ] {
        let mut neutral = processing.clone();
        neutral.source_kind = kind;
        assert_eq!(
            classify_v3_active_key_failure(&neutral, true),
            V3ActiveKeyFailureClass::Neutral
        );
    }
    assert_eq!(
        plan_v3_active_key_recovery(V3ActiveKeyFailureClass::Neutral, true),
        V3ActiveKeyRecoveryAction::Neutral
    );
}

#[test]
fn active_codec_failure_is_internal_processing_and_leaves_http_witness_separate() {
    let mut original = source(200, "provider_response_json_invalid");
    original.external_error.as_mut().unwrap().code = Some("PROVIDER_RESPONSE_JSON_INVALID".into());
    assert_eq!(
        normalize_v3_active_key_failure_source(original.clone(), false),
        original
    );
    let normalized = normalize_v3_active_key_failure_source(original.clone(), true);
    assert_eq!(normalized.code, original.code);
    assert_eq!(normalized.message, original.message);
    assert!(normalized.external_error.is_none());
    assert!(is_v3_recoverable_response_processing_source(&normalized));
    assert_eq!(
        classify_v3_active_key_failure(&normalized, true),
        V3ActiveKeyFailureClass::NonretryableDelivery
    );
    let real_http = source(500, "provider_http_500");
    assert_eq!(
        normalize_v3_active_key_failure_source(real_http.clone(), true),
        real_http
    );
    let mut transport = source(200, "provider_response_body_error");
    transport.external_error.as_mut().unwrap().kind = V3ExternalErrorKind::Transport;
    assert_eq!(
        normalize_v3_active_key_failure_source(transport.clone(), true),
        transport
    );
}
