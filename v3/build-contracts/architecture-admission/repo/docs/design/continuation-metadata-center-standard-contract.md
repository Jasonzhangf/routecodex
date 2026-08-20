# Continuation MetadataCenter Standard Contract

## Goal

Define one canonical request-scoped continuation contract for `MetadataCenter`, so continuation behavior is no longer assembled from scattered fields such as `responsesResume`, `fullInput`, `deltaInput`, `restoredTools`, `previous_response_id`, or ad hoc metadata merges.

This contract is the implementation target for:

- continuation save
- continuation restore
- continuation materialize
- continuation release

It applies to protocol semantics first, and code paths second.

## Main Rule

Continuation is a standard contract, not a convenience heuristic.

That means:

1. save behavior must be standardized by protocol and ownership
2. restore behavior must read one canonical continuation family
3. materialize behavior must be explicit and protocol-scoped
4. release behavior must physically shrink retained state to the minimum legal continuation truth

No stage may independently guess continuation truth from local payload shape once the center contract exists.

## Canonical Family

Continuation must live in `MetadataCenter.continuation_context`.

It must not be split across:

- request payload normal fields
- response payload normal fields
- protocol-specific metadata residue
- bridge-local guessed state
- stopless-specific private carriers

## Canonical Contract

```ts
type ContinuationContext = {
  protocol: 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'none'
  owner: 'direct' | 'relay' | 'none'
  mode: 'none' | 'remote_resume' | 'local_materialize' | 'submit_tool_outputs'
  stateKey?: string
  requestId?: string
  previousRequestId?: string
  responseId?: string
  previousResponseId?: string
  providerKey?: string
  entryKind: 'responses' | 'chat' | 'messages'
  sessionId?: string
  conversationId?: string
  scopeKey?: string
  fullInput?: JsonValue[]
  deltaInput?: JsonValue[]
  restoredTools?: JsonValue[]
  toolOutputs?: JsonValue[]
  submittedToolCallIds?: string[]
  pendingToolCallIds?: string[]
  provenance: {
    writtenBy: string
    stage: 'save' | 'restore' | 'materialize' | 'release'
  }
}
```

## Standard Behavior By Protocol

### 1. `openai-responses` + `owner=direct`

Save:

- save minimal remote ownership truth only
- legal fields:
  - `protocol=openai-responses`
  - `owner=direct`
  - `mode=remote_resume`
  - `responseId` / `previousResponseId`
  - `providerKey`
  - `entryKind=responses`
  - `sessionId/conversationId/scopeKey`
- do not save local materialized history as remote truth

Restore:

- requires explicit continuation evidence
- requires same `entryKind=responses`
- requires same `providerKey`
- may rebuild protocol wire anchor fields from canonical continuation context

Materialize:

- not the default path
- direct continuation restores remote anchor truth, not local reconstructed full history

Release:

- keep only minimal remote ownership truth
- do not retain extra local replay state that could later impersonate relay materialization

### 2. `openai-responses` + `owner=relay`

Save:

- save local continuation truth
- legal fields:
  - `protocol=openai-responses`
  - `owner=relay`
  - `mode=local_materialize` or `submit_tool_outputs`
  - `fullInput`
  - `deltaInput`
  - `restoredTools`
  - `toolOutputs`
  - `entryKind=responses`
  - `sessionId/conversationId/scopeKey`

Restore:

- requires explicit continuation evidence or explicit local relay restore entry
- restore must come from local store only
- restore must project canonical continuation context first, not protocol-shaped fragments

Materialize:

- allowed and explicit
- `fullInput` and `restoredTools` are part of the same canonical continuation truth
- tools must never be recoverable only through a second guessed path

Release:

- after request closeout, retain only the minimal replay-safe continuation truth needed for the next legal relay restore
- historical payload residue that is not part of the canonical continuation family must be removed

### 3. `openai-chat` / `anthropic-messages`

Default:

- `protocol=openai-chat|anthropic-messages`
- `owner=none`
- `mode=none`

Rule:

- these protocols must not accidentally consume `/v1/responses` continuation truth
- if future explicit continuation semantics are added, they must enter the same canonical family, not a second protocol-local state surface

## Standard Actions

### Save

Unique owner responsibility:

- determine whether the current turn has legal continuation rights
- encode continuation truth into one canonical family
- attach provenance

Forbidden:

- writing partial continuation truth into payload and the rest into side metadata
- writing `fullInput` without its matching `restoredTools` if the next restore depends on both

### Restore

Unique owner responsibility:

- validate legal continuation entry
- read one canonical continuation context
- rebuild the request-scoped continuation projection from the center

Forbidden:

- protocol bridge guessing missing continuation fields from local payload shape
- reader-specific fallback chains such as "if no restored tools, try somewhere else"

### Materialize

Unique owner responsibility:

- expand canonical continuation context into the exact next request semantic input
- materialization must be explicit by protocol and owner

Forbidden:

- hidden materialization during ordinary create
- materializing one protocol's continuation through another protocol's entry

### Release

Unique owner responsibility:

- shrink retained state after closeout
- preserve only next-turn-legal continuation truth
- mark released provenance

Forbidden:

- retaining duplicate payload-like continuation residue beside the canonical family

## White-box Test Matrix

These tests must exist at the canonical owner layer:

1. save
   - `direct responses save stores only remote ownership truth`
   - `relay responses save stores fullInput and restoredTools together`
   - `chat/messages save does not create responses continuation`
2. restore
   - `direct restore requires same providerKey and responses entryKind`
   - `relay restore returns canonical continuation context with fullInput and restoredTools`
   - `scope-only hit cannot restore continuation`
3. materialize
   - `relay materialize rebuilds fullInput and tools from one canonical context`
   - `direct restore does not local-materialize relay history`
4. release
   - `release removes non-canonical continuation residue`
   - `release keeps only next-turn-legal continuation truth`

## Black-box Test Matrix

These tests must prove final behavior, not internal fields:

1. `/v1/responses` relay continuation final provider request preserves tools
2. `/v1/responses` direct continuation pins same provider and does not local-materialize relay history
3. ordinary `/v1/responses` create does not auto-resume from scope history
4. `/v1/chat/completions` and `/v1/messages` do not consume responses continuation
5. stopless relay continuation keeps schema feedback and tool availability together in final provider request

## Migration Rule

Before more continuation bug-fix patches:

1. canonicalize current fields into this contract
2. move writers to one family
3. move readers to one projection
4. delete duplicate continuation residue
5. add gates preventing protocol-local continuation truth from reappearing

Until then, any field-level patch is temporary debugging evidence, not architecture closeout.
