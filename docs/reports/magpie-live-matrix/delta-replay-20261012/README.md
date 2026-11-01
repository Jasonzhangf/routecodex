# Delta Replay 20261012 (G4)

G4 thin source integration plus the four required real-entry replays. Raw
evidence lives under `latest/`. Nothing here changes the original 48-case
baseline under `../installed-baseline-20261012/`; that baseline stays untouched.

## Runtime identity

- binary: `/Users/fanzhang/.local/bin/rccv3` (`installed`)
- version: `rccv3 0.90.4887 (crate 0.1.0)`
- sha256: `5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563`
- source sha: `88715b2fe74ce4e6254f4d29ef1528b6848d4dff`
- fixture source sha: `bfaedf18301d02a423bd5422d22e41432d231ab8`

The current binary is `0.90.4887`, not the `0.90.4886` used by the original
baseline. The new results are a separate delta and do not merge into or claim
the old runtime baseline.

## Source integration (G4 scope only)

- `v3/scripts/tests/v3-protocol-live-mock-matrix.mjs`: removed the old
  single-candidate guard. It now forwards the declared `runtime_setup`
  candidates and copies every generated provider file (from G1
  `provider_files`) into `config-identity.json`, together with
  `candidate_identity_receipts` and `candidate_ids`. A single candidate keeps
  the historic `provider.toml` name.
- `v3/scripts/tests/protocol-live-mock/case-runner.mjs`: calls G2
  `assertProviderAttemptSequence` only when `expected_provider.auth_orders` is
  declared. Every other turn keeps the existing `assertProviderCaptures` path.
- `v3/scripts/tests/protocol-live-mock/case-runner.test.mjs`: added a red
  control. A valid `A -> B` order passes; a same-identity `A -> A` retry fails
  even when the second script is healthy.

No lifecycle, assertion-helper, fixture, runtime, or operator file was edited.

## Commands and results

Node helper suite (no skips):

```text
node --test --test-timeout=30000 v3/scripts/tests/protocol-live-mock/*.test.mjs
# tests 143, pass 143, fail 0, skipped 0  (exit 0)
```

Replay (serial, one owned foreground RCC child per case):

```text
node v3/scripts/tests/v3-protocol-live-mock-matrix.mjs --case <id> --evidence ... --report-path ...
```

| case | exit | status | attempts | note |
| --- | --- | --- | --- | --- |
| provider-fault-stream-cut | 0 | passed | 2 | A->B distinct identities, recovered response |
| provider-error-exhaustion | 1 | failed (product) | 1 | real 429 then empty closed client |
| chat-to-chat-json | 0 | passed | 1 | single-candidate control |
| tool-followup-responses-to-chat | 1 | failed (product) | 2 | provider request shape + client projection |

## Real-entry observations

provider-fault-stream-cut (recovered):

- Two business POSTs to `/v1/chat/completions`, both wire model `chat-model`.
- Authorization order is `Bearer fake-loopback-token-mock-chat-a` then
  `...-mock-chat-b`, one of the two declared orders. This is a distinct-identity
  reselection, not a same-candidate retry.
- `provider_files` receipts both provider files with distinct sha256 values;
  `candidate_identity_receipts.tier_count = 1` with two declared candidates.
- Client received the complete recovered response with no cut or `EOF`.

provider-error-exhaustion (product observation, `first_divergence=client_response`):

- One real business POST with wire model `unavailable-model`; the mock served
  the declared 429. This is a real exhaustion, not a model-selection failure.
- Client saw `status=null`, empty body bytes, `closed` transport. No provider
  error payload and no substitute success reached the client.
- The remaining diagnostic is `expected closed transport but received a parsed
  observation`: the harness stores a parse observation even for an empty body,
  so the strict `transport=closed` check sees an observation object. Product
  behavior (no error bytes, empty close) is correct; the observation bookkeeping
  for a zero-byte close is the open item. No golden was weakened.

tool-followup-responses-to-chat (product observation, `first_divergence=provider_request_shape`):

- The echo consumer executed once from the actual response. The real call id
  `call_echo_1`, arguments `{"text":"ping"}`, and output `ping` are preserved
  into the next real request; the observer call-id fix holds.
- Provider wire diffs: the Chat projection adds `stream_options.include_usage`
  and wraps tools as `{type:function, name, function:{name,description,parameters}}`,
  while the fixture expects `tools.0.function.name` and `stream` equality.
- Client body uses `output[0]={type:output_text,text:done}`, so the fixture key
  `output.0.content.0.text` is absent. These are fixture-vs-current-projection
  mismatches to reconcile, not runtime fixes made here.

## Cleanup

All four cases report `cleanup.complete = true`: owned child exit observed,
primary and admin listeners closed, mock closed, and generated config/state
removed. No production config, credential, or daemon was touched. The earlier
pre-G1 attempt under `provider-fault-stream-cut/` is retained as a historic
failure record and is superseded by `latest/`.
