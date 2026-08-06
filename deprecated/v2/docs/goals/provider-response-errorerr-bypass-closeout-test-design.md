# Provider Response ErrorErr TS Bypass Closeout Test Design

## Goal

Close `hubpipeline-full-rust-closeout-plan.md` section 11.16 item 3 error path before changing success delivery. The provider-response Node host may capture raw body/SSE/transport evidence and execute IO, but it must not classify or remap an error into `code`, `status`, `statusCode`, `retryable`, or `upstreamCode`.

## Lifecycle Contract

```text
ProviderRespInbound01Raw
  -> raw body/SSE/transport evidence capture in Node
  -> ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

`provider-response-converter.ts` is an IO host at the first boundary. It may throw the original error or a Rust-produced descriptor, but it may not perform the ErrorErr03 classification or ErrorErr06 projection itself.

## Whitebox Cases

1. Positive: provider-response converter contains no imports or calls for TS rate-limit, context-length, network, provider-configured, or bridge-SSE error remapping.
2. Positive: provider-response converter contains no assignments to normalized error fields `code`, `status`, `statusCode`, `retryable`, or `upstreamCode`.
3. Positive: provider-response converter contains no local recoverability decision based on `requestExecutorProviderErrorStage` plus `retryable`.
4. Negative: each forbidden classifier/remapper import or call makes the architecture gate fail.
5. Negative: each forbidden normalized-field assignment makes the architecture gate fail.
6. Negative: a revived message/name/code predicate for SSE/context/rate/network classification makes the architecture gate fail.
7. Positive: `request-executor-provider-send-failure.ts` sends every non-disconnect provider-response processing failure into the normal ErrorErr failure plan; it does not pre-filter by TS status/stage/retryable/code logic.
8. Positive: `request-executor-provider-failure.ts` captures explicit source stage or uses the caller-provided provider stage; it does not infer `provider.sse_decode` from TS message/status helpers.
9. Negative: restoring `remapBridgeSseErrorToHttp`, `isRetryableProviderResponseProcessingFailure`, `isSseDecodeRateLimitError`, or `isSseDecodeRetryableNetworkError` fails the gate.
10. Positive: legacy `provider-response-sse-error-normalizer.ts` and its old `provider-response-converter-empty-sse.spec.ts` remain physically deleted; reviving either fails the same residue gate.

## Module Blackbox

1. Raw provider SSE error evidence reaches the Rust ErrorErr owner without TS rewriting.
2. Rust descriptors preserve provider status/code/retryability semantics for rate limit, context length, network/decode failure, and generic malformed conversion.
3. Success body/SSE conversion remains unchanged during this error-only slice.
4. Malformed or unknown Rust descriptors fail fast; Node must not synthesize replacement status/error fields.

## Rust Provider-Origin Recoverability Cases

1. Positive: provider-origin `401` / `402` / `403` / `404` remains `recoverable`, including `INVALID_API_KEY`, `INVALID_ACCESS_TOKEN`, `INSUFFICIENT_QUOTA`, `ACCOUNT_DISABLED`, `ACCOUNT_SUSPENDED`, `ACCESS_DENIED`, and `FORBIDDEN`. ErrorErr05 must keep these failures reroutable while either the current route or default pool still has a target.
2. Positive: a streaming provider `403` with the current route exhausted and `defaultPoolAvailable=true` produces `shouldRetry=true`, excludes the failed provider, and keeps `mayProject=false`.
3. Negative: `MALFORMED_REQUEST`, `CLIENT_TOOL_ARGS_INVALID`, local provider-runtime request-contract failures, local response-contract failures, and invalid tool/message/input parameters remain non-reroutable.
4. Negative: `client_disconnect` remains health-neutral and outside provider failover even though its classification sentinel is `unrecoverable`.
5. Negative: terminal projection is still allowed only after both the current route and default pool are empty; changing provider-origin classification must not turn local protocol/client errors into retry success truth.

## Project Blackbox

1. Provider-facing request payload remains unchanged.
2. Client-facing error is emitted only after ErrorErr05/06 policy permits projection.
3. A provider failure remains reroutable until optional and default pools are both empty.
4. Success, failure, non-terminal/still-running, and already-terminal response paths remain distinct.

## Initial Red Gate

```bash
npm run verify:provider-response-errorerr-bypass-closeout
npm run test:provider-response-errorerr-bypass-closeout-red-fixtures
```

The first command must fail on the current source before implementation because the converter still performs TS error classification and normalized-field mutation. The fixture command must pass by proving each forbidden revival makes the verifier fail.

## Green And Closeout Gates

```bash
npm run verify:provider-response-errorerr-bypass-closeout
npm run test:provider-response-errorerr-bypass-closeout-red-fixtures
cargo test -p router-hotpath-napi provider_origin_auth_quota --lib
cargo test -p router-hotpath-napi local_contract_failure_remains_unrecoverable --lib
npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.error-logging.spec.ts tests/server/runtime/http-server/executor/request-executor-provider-send-failure.abort.spec.ts tests/server/runtime/http-server/executor/request-executor-provider-failure-stage.regression.spec.ts --runInBand
npm run verify:error-pipeline-contract
npm run verify:function-map-compile-gate
npm run verify:architecture-review-surface-light
npm run build:native-hotpath
ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base
```

Release/global install, aggregate restart, and same-entry live replay require explicit authorization and are not implied by source/native/build green gates.
