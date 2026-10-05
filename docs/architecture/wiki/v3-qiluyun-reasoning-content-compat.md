# Qiluyun Responses empty reasoning content

The explicit `responses:qiluyun` profile owns Qiluyun's private representation
of an optional empty reasoning content field. It runs at the existing Provider
Compat boundary after standard Responses projection, for Direct and Relay.

The captured complete Codex history returns HTTP400 with
`reasoning.content must be an array`. Changing only40 `reasoning.content: null`
fields to empty arrays returns HTTP200 with a valid Responses terminal. This
is an added provider's representation limit, not a reversal of the Chat tool
name repairs in PR341 and PR343.

The profile changes only explicit null content on reasoning items to `[]`.
It preserves each item, identifiers, summaries, nonempty content, absent
optional content, and tool call/output pairs. Other profiles and protocols
retain their own representation. It never deletes reasoning or changes routing,
health, retry, or error state.

Select the profile in the provider authoring file with
`compatibilityProfile = "responses:qiluyun"`. The config remains the control
truth; no profile or diagnostic state is placed in business payloads.

`npm run test:v3-qiluyun-reasoning-content-blackbox` sends the history through
the public `/v1/responses` entry to a real HTTP peer. The peer rejects null
content and accepts an empty array. The test verifies preserved history and
schema, one attempt, a successful client response for the selected profile,
and observable failure for the unchanged generic profile. Installed acceptance
also replays the complete captured history against the real Qiluyun endpoint.
