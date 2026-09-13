# Retired: ServerTool / Stopless Lifecycle

This file is retained as a historical audit pointer only. It is not an active
RouteCodex V3 contract and must not be used to restore the old Stopless
runtime, CLI, MetadataCenter state machine, reasoning-stop injection, or
stop-response interception.

## Retirement boundary

The following RouteCodex-owned resources are retired:

- Stopless and `stop_message_auto` request/response hooks;
- `reasoningStop` schema injection and client-visible no-op CLI projection;
- Stopless loop counters, prompt rewriting, continuation guidance, and state
  persistence;
- server-side reentry and any Stopless-specific `ServertoolCenter` branch;
- the old Stopless CLI/result pair and its dedicated validation or live replay.

The active V3 servertool boundary is documented in
`docs/agent-routing/30-servertool-lifecycle-routing.md`. V3 retains only the
ordinary servertool and tool-call hook paths that are bound by the current
resource/function/mainline/verification maps.

## Replacement boundary

The official Stop hook, timer hooks, and future memory hooks are independent
features of the `codex-hooks` framework. Their daemon owns hook state and
working/idle admission; CodexApp owns the native `sendmessage` input
interface. They do not re-enter RouteCodex V3 runtime and do not add
RouteCodex control fields to request or response payloads.

## Historical material

Earlier revisions of this file described the retired closed loop, including
the `reasoningStop` command, `StoplessCenter`, `repeatCount`/`maxRepeats`, and
schema-driven prompt injection. Those descriptions are historical evidence,
not implementation requirements. New work must not revive them; use the
independent hooks design and its own tests instead.
