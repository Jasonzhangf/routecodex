# Retired: Provider Error Unified Interface Contract Plan

Retired on 2026-10-24. The July implementation prompt is no longer an execution
plan. Its client error projection and model-content classification requirements
conflict with the current [project contract](../../AGENTS.md). Do not dispatch
its old goal, rebuild its response-content judge, or restore its display policy.
Git history retains the historical design and sample discussion.

Current requirements are owned by AGENTS.md and `.appsdk/requirements.json`:

- Genuine Provider failures enter the typed Error chain. Candidate recovery
  stays inside Runtime. Exhaustion ends only the request transport, without a
  client error payload or fabricated success.
- Model business content, including invalid tool arguments, remains business
  content. Diagnostic words, zero usage or a local schema preference do not
  authorize semantic rejection of a representable response.
- Runtime consumes compiled provider action policy and typed request scope.
  `routing_group` is a real isolation condition; issue `720eb7f` repairs its
  missing matcher consumption.
- Issue `2f2ab62` retires the unused `client_error_projection_policy` and
  `Project.status/message_mode`. Remove the obsolete policy declaration and
  those two Project fields from operator configuration. Keep supported
  recovery steps and the internal `reason_code/public_code` fields. The public
  Config parser reports obsolete fields explicitly; it does not silently accept
  them. This configuration rule is not business-payload admission validation.

Use the [Error DAG](../architecture/dagpipe/v3.operation_runner.error.graph.json),
[owner map](../architecture/v3-function-map.yml) and
[verification map](../architecture/v3-verification-map.yml) for current work.
This retirement records the contract and migration; it does not claim that the
referenced fixes are installed, reviewed, merged or delivered.
