# Retired: Provider Error Disposition Path Config Plan

Retired on 2026-10-24. The August plan is historical. Its client error response,
business-content rejection, expiry-only recovery, provider-wide exclusion and
hourly/restart-only probe instructions are not current implementation tasks.
Git history preserves the original design; do not dispatch its old checklist.

The current [project contract](../../AGENTS.md) owns these requirements:

- Provider failure recovery stays in the typed Error chain. The model client
  receives business content or detectable request-transport termination, never
  a replacement error response.
- Automatic failure exclusion, cooldown and recovery use the complete
  `provider.model.key` identity. Other identities must remain unaffected.
  Recovery timing and probe success follow the current contract, not this
  retired plan's hourly policy or expiry-only restoration.
- Config owns the supported provider action/path declaration. Runtime consumes
  the compiled policy; control state does not enter business payload.

For the retired projection-field migration, see the
[unified-interface retirement notice](v3-provider-error-unified-interface-contract-plan.md).
`reason_code/public_code` remain internal diagnostic inputs; their names do not
authorize client error projection. Use the
[Error DAG](../architecture/dagpipe/v3.operation_runner.error.graph.json) and
[verification map](../architecture/v3-verification-map.yml) to select current
implementation and acceptance work. This notice does not certify runtime
conformance or close any outstanding defect.
