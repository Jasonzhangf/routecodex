# Provider model authoring + multi-select CRUD (frozen contract)

Status: frozen before implementation. Scope owner: WebUI Providers page.

## Why

An operator looking at an existing provider in the WebUI can only READ its models.
The Providers page renders `config.provider.models` as a list of names with no way
to add or remove one, and no way to pull the provider's own `GET {base_url}/models`
into that list. The capability the backend already has is unreachable from the UI:

- `POST /api/providers/discover` already performs one authenticated discovery GET
  with the provider's real credential and returns `models: [String]`.
- `PUT /api/providers/:id` already validates, backs up and writes a provider file.
- `POST /api/providers` / `PUT /api/providers/:id` are the only write paths.

The user's request (verbatim):

> 1. webui 的 provider 现在已有的 provider 没有办法添加 model，而且没有自动拉取
>    v1/models 选择添加的能力，应该加入
> 2. 应该要有多选进行操作，比如 crud

and, on how much a model entry should carry:

> 模型名和能力自动探测，允许手动勾选能力，但是手动能力需要测试

which fixes three requirements: model name and capabilities are **auto-detected**,
capabilities may also be **manually ticked**, and a manually ticked capability must
be **tested** before it is trusted.

Selected scope (user choice): "Model CRUD + provider bulk + route binding".

## Non-goals

- No change to provider selection, routing, health, cooldown or the error chain.
- No new config truth: provider files stay the only authoring source, written
  through the existing `config-mgmt` provider writer.
- No second discovery implementation: the existing authenticated discovery GET is
  the only one, and the existing onboarding wizard keeps working.
- No guessed capability. A capability is never written from a name heuristic alone.

## Entities

- **Provider**: identified by `provider_id`; file
  `<config_dir>/provider/<id>/config.v2.toml`.
- **Model entry**: key in `provider.models` (`BTreeMap<String, V2ProviderModelConfig>`),
  fields `wireName`, `aliases`, `capabilities`, `supportsStreaming`,
  `supportsThinking`, `thinking`, `maxTokens`, `maxContextTokens`, `contextWindow`.
- **Capability**: one of the strings the runtime already understands, e.g. `text`,
  `reasoning`, `thinking`, `tools`, `multimodal`, `vision`, `longcontext`,
  `web_search_direct`.
- **Capability source**: `detected` (inferred from the discovery response),
  `manual_tested` (ticked by the operator AND passing a real capability test),
  `default` (the baseline every model gets).

## Contract

### E1 - model CRUD on an existing provider

One endpoint mutates the model map of an existing provider, doing the read-modify-write
server-side so the client never has to round-trip a whole provider config:

```
POST /api/providers/:id/models
{
  "add":    { "<model-name>": { <V2ProviderModelConfig fields, all optional> } },
  "replace": ["<model-name>", ...],
  "remove": ["<model-name>", ...],
  "defaultModel": "<model-name>" | null,
  "reason": "<string>" | null
}
```

- The response is the resulting `models` map, the resulting `defaultModel`, the
  backup path and the revision sequence.
- `add`, `remove` and `replace` are all optional and may be combined; at least one
  of `add`/`remove` must be present or the request is `400 no_model_mutation`.
- **Ordering is pinned: `remove` is applied before `add`.** A request that both
  removes and re-adds the same name is therefore an explicit edit, not a collision.
- **The replacement marker is pinned: `replace` is a top-level list of names**, not
  a key inside a model entry. A name listed in `replace` may overwrite an existing
  entry; adding an existing name that is NOT listed is `409 model_exists` - a silent
  overwrite of an authored entry is never allowed. Config-field objects stay pure
  config fields, so no control flag leaks into `V2ProviderModelConfig`.
- An edit is therefore either `{remove: [n], add: {n: {...}}}` in one request, or
  `{add: {n: {...}}, replace: [n]}` - both are legal and both are one round trip.
- Removing a name that does not exist is `404 model_not_found`.
- Removing the model named by `defaultModel` is `409 default_model_in_use` unless
  the same request also sets `defaultModel` or re-adds that name.
- An empty resulting model map is allowed only if the provider has no
  `defaultModel`; otherwise `409 default_model_requires_model`.
- Validation, backup and revision reuse the existing provider write path
  (`validate_provider_candidate` + `write_provider_file_with_backup`), so a rejected
  candidate writes nothing.

### E1a - the write re-serializes the file, and the UI says so

Verified live on `lmstudio` (25 models) with a real add followed by a real remove:

- the write goes through the typed schema, so the file comes back in canonical form:
  key order inside `[provider]` changes, `sse_first_frame_timeout_ms` is written as
  `sseFirstFrameTimeoutMs` (that field carries `alias = "sse_first_frame_timeout_ms"`,
  so both spellings load), model entries gain an explicit `aliases = []`, and keys the
  schema does not model are dropped (`[provider.auth] type`, the whole
  `[provider.capabilities]` block).
- **No setting the runtime actually reads is lost.** `auth.type`, `provider.capabilities`,
  `transportBackend`, `selectionMode`, `headerName` and `rawType` have zero Rust readers;
  `apiKey` and every modelled field survive. The config still compiled
  (`config ok: version=3 servers=2`), and the file was restored byte-identically afterwards.
- What IS lost: TOML comments and any unmodelled key. 5 of 62 provider files carry comment
  lines. The model dialog therefore discloses the rewrite instead of letting it surprise an
  operator. A comment-preserving writer is out of scope here and is not invented.

### E2 - discovery returns structured entries

The existing discovery GET stays the only implementation and stays authenticated
with the provider's real credential. Its response gains the structured view:

```
POST /api/providers/discover   { "id": "<provider>" }
-> { ok, provider_id, provider_type, base_url, auth_alias, count,
     models:  [ "<name>", ... ],                      // unchanged, compatibility view
     entries: [ { name, capabilities: [...], maxTokens?, maxContextTokens?,
                  source: "detected"|"default" } ] }
```

- `models` keeps its exact current shape so the onboarding wizard and its L4 test
  do not regress.
- `entries` is derived from the same single HTTP response; no second request.
- Capability inference is provider-shaped and best-effort: read whatever the
  provider actually returned (OpenAI-compatible `supported_parameters` /
  `architecture.input_modalities` / `context_length`, Anthropic `display_name`,
  Gemini `supportedGenerationMethods` / `inputTokenLimit`). A provider that returns
  only ids yields `capabilities: []` and `source: "default"` - never a guess.

### E3 - capability test before a manual tick is trusted

```
POST /api/providers/:id/models/capability-test
{ "model": "<name>", "capabilities": ["vision", "tools"], "reason": null }
-> { ok, model, results: [ { capability, tested: bool, passed: bool,
                            detail: "<string>", evidence: {...} } ] }
```

- A capability is `tested: true` only when a real request exercising it was sent to
  the provider and its outcome was inspected; otherwise `tested: false` with the
  reason.
- The test is read-only with respect to config: it never writes the provider file.
  Persisting the tested capability is a separate `POST /api/providers/:id/models`
  call from the client.
- A capability that cannot be exercised cheaply and deterministically reports
  `tested: false` and is therefore NOT persistable as `manual_tested`.
- `text` is always testable. `tools` sends a tool definition and requires a tool
  call. `vision` sends a minimal image part. `thinking`/`reasoning` require
  reasoning output. `longcontext` reports `tested: false` (not cheaply provable).
- The test must not touch provider health/cooldown state: it is an operator
  diagnostic, like the existing ad-hoc diagnostic, and its result is returned to
  the caller rather than folded into runtime health.

### E4 - the WebUI must never write an untested manual capability

The add/edit dialog shows, per capability, whether it is `detected`, `manual`, or
`default`. A capability the operator ticks manually is written only after its
capability test returned `passed: true` in that dialog session. If the test fails or
is unavailable, the tick is refused with the reason shown, and the capability is not
written. Detected capabilities do not require a test.

### E5 - model multi-select CRUD

The Models section of the provider drawer becomes editable:

- every model row has a checkbox; header checkbox selects all currently visible;
- a filter box narrows the list;
- bulk actions operate on the checked set: **remove**, **set as default**;
- single-row actions: **edit**, **remove**.

### E6 - discover-and-pick

A **Fetch models** action calls the discovery endpoint and opens a picker:

- lists every discovered entry with its detected capabilities and limits;
- marks entries already configured (not selectable for add, shown as such);
- header checkbox + filter + per-row checkbox;
- **Add selected** writes exactly the checked set through the E1 endpoint in one
  request.

### E7 - provider-level multi-select CRUD

The provider list gains checkbox selection and a bulk bar operating on the checked
set: **enable**, **disable**, **probe**, **delete**. Delete requires an explicit
confirmation naming the count, and reuses the existing provider delete endpoint.

### E8 - bulk route binding

The bulk bar can bind the checked providers into a route pool tier using the
existing route write path (`PUT /api/routes`); it must not invent a second routing
truth. The action is unavailable when no route target is chosen.

### E9 - errors are shown, not swallowed

Every failed action surfaces the server's own error code and message. No optimistic
UI state: the drawer re-reads the provider after any write.

### E10 - no new config truth

All writes go through the existing provider/route config writer with its backup and
revision behaviour. No state is persisted anywhere else, and nothing is written to
request/response payloads or logs.

## Acceptance evidence

1. Backend tests: add/remove/default mutations against a temp config dir; the
   `409`/`404`/`400` cases; a rejected candidate leaves the file byte-identical.
2. Discovery: one HTTP request, `models` unchanged in shape, `entries` carrying
   detected capabilities for a provider that reports them and `[]`+`default` for one
   that does not.
3. Capability test: a passing capability, a failing capability, and a
   not-cheaply-testable capability (`longcontext`) reported `tested: false`; the
   provider file is untouched by the test.
4. WebUI smoke: the drawer renders models with checkboxes, the picker lists
   discovered entries, an untested manual capability cannot be written.
5. Live: on the running instance, fetch models for a real provider, add a selected
   model, observe it in the provider file and in a fresh drawer read, then remove it
   and observe the file restored. Record the backup path.
6. Gates: `verify:v3-cargo-fmt`, `verify:v3-file-size`, `verify:v3-module-boundaries`,
   `verify:webui-smoke`, `verify:function-map-compile-gate`,
   `verify:v3-dagpipe-feature-graphs`, `verify:v3-contract-map-owner`.

## Write scopes (disjoint)

- backend: `v3/crates/routecodex-v3-admin/src/provider_models.rs` (new),
  `v3/crates/routecodex-v3-admin/src/provider_onboarding.rs`,
  `v3/crates/routecodex-v3-provider-responses/src/transport.rs`,
  `v3/crates/routecodex-v3-admin/src/lib.rs` or `src/api/mod.rs` (route registration),
  `v3/crates/routecodex-v3-admin/tests/**`.
- frontend: `v3/admin-webui/app/views/providers.js`,
  `v3/admin-webui/app/views/provider-models.js` (new),
  `v3/admin-webui/providers.html`, `v3/admin-webui/styles.css`,
  `v3/admin-webui/*-smoke.mjs`.
- lead (integration only): `docs/architecture/v3-function-map.yml`.
