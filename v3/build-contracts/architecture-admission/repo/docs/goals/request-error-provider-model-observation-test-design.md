# Request Error Provider/Model Observation Test Design

## Lifecycle

`ProviderReqOutbound07TransportRequest` failure -> ErrorErr01-05 policy handling -> final original error carries the selected target observation -> `ErrorErr06ClientProjected` request log renders `provider` and provider wire `model`.

## Positive

- A terminal provider failure retains the actual selected `providerKey` and `providerModel` on the original error.
- The request failure log renders both fields alongside the existing status and code.

## Negative

- Missing or blank observations are not rendered as `undefined` or empty fields.
- Existing observation truth is not overwritten.
- Message, status, code, retry policy, client response payload, and provider wire payload remain unchanged.

## Gates

- `tests/server/runtime/http-server/executor/request-executor-error-observation.spec.ts`
- `tests/server/handlers/request-error-log.spec.ts`
- `npm run verify:error-pipeline-contract`
- `npm run verify:function-map-compile-gate`
- `npx tsc --noEmit --pretty false --skipLibCheck`

## Known Gap

Source tests do not prove installed-runtime output. Production closure requires replaying a real terminal provider rejection through the global installed runtime and observing the final server log.
