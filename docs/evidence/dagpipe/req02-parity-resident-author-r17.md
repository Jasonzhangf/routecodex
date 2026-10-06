# req02 parity resident author receipt r17

## Scope

- Updated only the `providerCompatErrorEdge` caller symbol assertion and its matching red fixture.
- Product code, maps, profiles, locks, and other architecture gates were not changed.
- The provider failure callee, caller file, owner, node edge, and resource constraints remain unchanged.

## Red

Command:

```text
node v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
```

- Exit: `1`
- Raw log: `.execution/parity-r17-red.log`
- Diagnostic:

```text
[verify:v3-protocol-conversion-field-parity] failed
- docs/architecture/v3-mainline-call-map.yml: ProviderReqCompat06 typed failure edge caller_symbol must be execute_v3_responses_relay_runtime_inner
```

Only the stale `v3-provider-action-gate-01` caller assertion failed. No unrelated gate failure was observed.

## Fix

Files changed:

- `v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs`
- `v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs`

Exact diff:

```diff
diff --git a/v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs b/v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
index 936f99585..a479cca84 100644
--- a/v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
+++ b/v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
@@ -902,7 +902,7 @@ const providerCompatErrorEdge = (providerActionGateChain?.edges ?? []).find(
 for (const [key, expected] of [
   ['from_node', 'ProviderReqCompat06ProviderCompat'],
   ['to_node', 'V3Error05ExecutionDecision'],
-  ['caller_symbol', 'execute_v3_responses_relay_runtime_inner'],
+  ['caller_symbol', 'execute_v3_responses_relay_runtime_resident'],
   ['caller_file', paths.responsesRuntimeInner],
   ['callee_symbol', 'handle_v3_responses_relay_provider_failure'],
   ['callee_file', paths.responsesRuntime],
diff --git a/v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs b/v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
index d30d7d830..ec7b6cd27 100644
--- a/v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
+++ b/v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
@@ -770,6 +770,19 @@ const cases = [
       to_node: V3ProviderReqOutbound09TransportRequest`,
     diagnostic: /ProviderReqCompat06 typed failure edge|V3Error05ExecutionDecision/u,
   },
+  {
+    name: 'Provider compat failure caller regresses to wrapper guard',
+    file: 'docs/architecture/v3-mainline-call-map.yml',
+    from: `step_id: v3-provider-action-gate-01
+      from_node: ProviderReqCompat06ProviderCompat
+      to_node: V3Error05ExecutionDecision
+      caller_symbol: execute_v3_responses_relay_runtime_resident`,
+    to: `step_id: v3-provider-action-gate-01
+      from_node: ProviderReqCompat06ProviderCompat
+      to_node: V3Error05ExecutionDecision
+      caller_symbol: execute_v3_responses_relay_runtime_inner`,
+    diagnostic: /ProviderReqCompat06 typed failure edge caller_symbol must be execute_v3_responses_relay_runtime_resident/u,
+  },
   {
     name: 'OpenAI Chat malformed arguments exact preservation replaced by JSON-string rewrapping',
     file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
```

## Green

Command:

```text
node v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
```

- Exit: `0`
- Raw log: `.execution/parity-r17-green.log`
- Output: `[verify:v3-protocol-conversion-field-parity] ok`

Command:

```text
node v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
```

- Exit: `0`
- Raw log: `.execution/parity-r17-red-fixtures.log`
- Output: `[test:v3-protocol-conversion-field-parity-red-fixtures] ok (132 forbidden mutations rejected)`
- New reverse mutation: `Provider compat failure caller regresses to wrapper guard`
- Required diagnostic: `ProviderReqCompat06 typed failure edge caller_symbol must be execute_v3_responses_relay_runtime_resident`

Command:

```text
node --check v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
node --check v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
git diff --check
```

- Exit: `0` for each command

## Final hashes

```text
a7cbc4605e42ceeb96e026e654c9d78cf4473fe88f7cecfd9c5a9c7ac5b4083d  v3/scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs
b1b7d38d43805aa70609ca01b3eb5a701739721850160591e472d3cefafe139e  v3/scripts/tests/v3-protocol-conversion-field-parity-red-fixtures.mjs
```
