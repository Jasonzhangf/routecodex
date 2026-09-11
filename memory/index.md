# Memory Index

Index stores short titles, tags, and detail paths. Open the linked Markdown detail for content.

## Raw sources

- [Plan](plan.jsonl)
- [Path](path.jsonl)
- [Knowledge](knowledge.jsonl)
- [Lesson](lesson.jsonl)

## Level 1 — reviewed critical

_Empty._

## Level 2 — reviewed reusable

_Empty._

## Level 3 — new or unreviewed

### Chat Process contract
- tags: `chat-process`, `contract`, `extensions`, `relay`, `semantics`
- details: [L3/knowledge.routecodex.chat-process-contract.md](L3/knowledge.routecodex.chat-process-contract.md)

### Provider Compat contract
- tags: `compat`, `contract`, `owner`, `private-protocol`, `provider`
- details: [L3/knowledge.routecodex.compat-contract.md](L3/knowledge.routecodex.compat-contract.md)

### Error status policy
- tags: `502`, `598`, `599`, `contract`, `error`, `external-status`
- details: [L3/knowledge.routecodex.error-status-policy.md](L3/knowledge.routecodex.error-status-policy.md)

### Full-attempt client commit barrier
- tags: `buffer`, `commit`, `contract`, `provider`, `reselection`, `sse`
- details: [L3/knowledge.routecodex.full-attempt-buffer.md](L3/knowledge.routecodex.full-attempt-buffer.md)

### Inbound contract
- tags: `contract`, `extensions`, `inbound`, `lossless`, `normalization`
- details: [L3/knowledge.routecodex.inbound-contract.md](L3/knowledge.routecodex.inbound-contract.md)

### Outbound contract
- tags: `allowlist`, `contract`, `denylist`, `outbound`, `projection`
- details: [L3/knowledge.routecodex.outbound-contract.md](L3/knowledge.routecodex.outbound-contract.md)

### Record contract and implementation separately
- tags: `architecture`, `lesson`, `memory`, `remediation`, `v2`, `verification`
- details: [L3/lesson.routecodex.memory-truth-admission.md](L3/lesson.routecodex.memory-truth-admission.md)

### Do not conflate two relay concepts
- tags: `chat-process`, `direct`, `lesson`, `owner`, `relay`, `transport`
- details: [L3/lesson.routecodex.mode-vs-transport-relay.md](L3/lesson.routecodex.mode-vs-transport-relay.md)

### Buffer before client commit
- tags: `buffer`, `client`, `error`, `lesson`, `provider`, `sse`
- details: [L3/lesson.routecodex.provider-client-error-decoupling.md](L3/lesson.routecodex.provider-client-error-decoupling.md)

### Direct request and response flow
- tags: `buffer`, `direct`, `flow`, `hooks`, `provider`, `sse`
- details: [L3/path.routecodex.direct-request-response.md](L3/path.routecodex.direct-request-response.md)

### Error classification and projection
- tags: `502`, `598`, `599`, `error`, `external-status`, `flow`
- details: [L3/path.routecodex.error-projection.md](L3/path.routecodex.error-projection.md)

### Direct or Relay selection
- tags: `configuration`, `direct`, `flow`, `relay`, `selection`
- details: [L3/path.routecodex.mode-selection.md](L3/path.routecodex.mode-selection.md)

### Relay request flow
- tags: `chat-process`, `compat`, `flow`, `inbound`, `outbound`, `provider`, `relay`, `request`
- details: [L3/path.routecodex.relay-request.md](L3/path.routecodex.relay-request.md)

### Relay response flow
- tags: `buffer`, `chat-process`, `error`, `flow`, `relay`, `response`, `sse`
- details: [L3/path.routecodex.relay-response.md](L3/path.routecodex.relay-response.md)

### Client and Provider decoupling
- tags: `architecture`, `buffer`, `decoupling`, `error`, `provider`, `sse`
- details: [L3/plan.routecodex.client-provider-decoupling.md](L3/plan.routecodex.client-provider-decoupling.md)

### Payload rewrite owners
- tags: `architecture`, `chat-process`, `direct`, `hooks`, `owner`, `payload`, `relay`
- details: [L3/plan.routecodex.payload-rewrite-owners.md](L3/plan.routecodex.payload-rewrite-owners.md)

### Skeleton and plane ownership
- tags: `architecture`, `configuration`, `control-plane`, `data-plane`, `skeleton`
- details: [L3/plan.routecodex.skeleton-and-planes.md](L3/plan.routecodex.skeleton-and-planes.md)

### Production version baseline
- tags: `architecture`, `baseline`, `v2-retired`, `v3`, `v4`
- details: [L3/plan.routecodex.version-baseline.md](L3/plan.routecodex.version-baseline.md)

## Skill description candidates

Base budget: 8 lines. Copy the compact lines into the project Skill `description` after manual architecture deduplication. Fill level 1 first; use level 2, then level 3, only for remaining slots.

- L3: Chat Process contract (knowledge) [chat-process,contract,extensions,relay,semantics] -> L3/knowledge.routecodex.chat-process-contract.md
- L3: Provider Compat contract (knowledge) [compat,contract,owner,private-protocol,provider] -> L3/knowledge.routecodex.compat-contract.md
- L3: Error status policy (knowledge) [502,598,599,contract,error,external-status] -> L3/knowledge.routecodex.error-status-policy.md
- L3: Full-attempt client commit barrier (knowledge) [buffer,commit,contract,provider,reselection,sse] -> L3/knowledge.routecodex.full-attempt-buffer.md
- L3: Inbound contract (knowledge) [contract,extensions,inbound,lossless,normalization] -> L3/knowledge.routecodex.inbound-contract.md
- L3: Outbound contract (knowledge) [allowlist,contract,denylist,outbound,projection] -> L3/knowledge.routecodex.outbound-contract.md
- L3: Record contract and implementation separately (lesson) [architecture,lesson,memory,remediation,v2,verification] -> L3/lesson.routecodex.memory-truth-admission.md
- L3: Do not conflate two relay concepts (lesson) [chat-process,direct,lesson,owner,relay,transport] -> L3/lesson.routecodex.mode-vs-transport-relay.md
