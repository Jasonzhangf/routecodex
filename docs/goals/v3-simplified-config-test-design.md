# V3 simplified user-config test design

Status: Phase 4 source/build/install and initial live replay passed. Final browser closeout and fresh AGY Review are blocked on restoration of the externally interrupted managed V3 instance; Phase 5 retirement remains unopened.

## Lifecycle under test

```text
V3UserConfig01FileSource
  -> V3UserConfig02RoutingSelectionParsed
  -> V3Config02AuthoringParsed
  -> existing V3Config03SchemaValidated
  -> existing V3Config04ResourceRegistryBuilt
  -> existing V3Config05ManifestPublished
```

The new owner stops at `V3Config02AuthoringParsed`. It must not implement schema validation, resource-registry construction, Manifest publication, provider-directory semantics, routing selection, or runtime file discovery.

## White-box tests

Positive:

- one group, one default pool, one provider/model member;
- multiple outer tiers preserve order by assigning the first tier the highest generated numeric priority (`N..1`), matching the current V3 Target runtime;
- one inner tier with omitted weights materializes equal weights;
- explicit valid same-tier weights preserve ratios;
- TOML table order does not affect parsed/projected output;
- the existing Config03/04/05 compiler accepts projected authoring.

Negative:

- unknown top-level and pool fields;
- empty route group, missing default, empty pool, or empty tier;
- malformed `use`, missing provider/model, disabled provider, or duplicate member;
- zero weight and mixed omitted/explicit weight in one tier;
- user-authored `priority`, `match`, `servers`, `pipelines`, `features`, `error`, `debug`, `admin_webui`, auth, endpoint, or execution fields;
- unknown group or pool not present in typed internal topology.

## Module black-box tests

- Parse minimal TOML through only the new explicit API.
- Project against a typed internal base and provider catalogue.
- Compile through existing Config03/04/05 functions.
- Prove invalid input returns an error before Config05 and does not mutate the supplied internal base.
- Prove two syntactically different valid inputs normalize to the same authoring/Manifest.

## Project black-box tests

- explicit CLI config check on `config.toml`;
- old/new runtime-effective Manifest differential;
- provider-request dry-run for every reachable route-pool class;
- CLI init and Admin/WebUI read/write;
- installed aggregate restart and live same-entry replay.

Exact path ownership must additionally prove:

- `server status -c <path>/config.toml` consumes the user-config Manifest and source identity;
- a legacy-shaped file named `config.toml` fails in the user parser without retrying `V3ConfigStore`;
- an explicit valid `config.v3.toml` remains on the legacy owner during staged cutover;
- lifecycle never selects a parser itself; it calls the Config-owned exact-path snapshot loader.

## Static red fixtures

The architecture gate must reject mutations that:

1. add another call to `publish_v3_config_05_manifest_from_v3_config_04` inside `user_config.rs`;
2. import the user parser from Runtime, Server, Virtual Router, Target, Provider, or Error crates;
3. introduce content/format sniffing, automatic dual read, parser retry, or silent parse recovery; exact basename selection in the Config owner is the only staged dispatch;
4. add internal-only user fields to the strict user schema;
5. write user-config/control fields into normal payload or protocol metadata.

## Phase 5 retirement evidence design

Retirement begins only after the Phase 4 AGY controller returns PASS. The zero-reference gate must distinguish the legacy user-file surface from the Config02-to-Config05 compiler contract that `internal.toml` still owns:

- remove `V3ConfigStore`, its public file IO/write API, and the exact-filename dispatcher branch; `load_v3_config_snapshot_from_path` must directly consume `V3UserConfigStore`;
- remove public `parse_v3_config_02_authoring` and legacy `config.v3.toml` validation diagnostics; internal topology parsing must have an internal-only owner and must still enter the existing Config03→04→05 chain;
- keep `V3Config02AuthoringParsed` and the unique Config03→04→05 compiler types/functions because they are the projection boundary and compiler contract, not legacy user-file compatibility;
- remove ConfigMgmt legacy authoring read/validate/commit branches and old route/forwarder editing assumptions; user route commits remain atomic through `V3UserConfigStore`;
- change standalone Admin and installation verification defaults to `config.toml` and reject reintroduction of an old default path;
- migrate tests that only need a typed Manifest to an explicit test-only Config02 builder/parser without restoring a public file parser or runtime authoring-file read;
- update resource/function/mainline/module/verification maps, generated wiki surfaces, install scripts, and canonical docs so no live instruction names `config.v3.toml` or `V3ConfigStore`;
- preserve historical evidence text only where its archival status is explicit; executable defaults, source symbols, gates, fixtures, and current operator instructions must have zero legacy references;
- reject `config.v3.toml`, `V3ConfigStore`, parser retry, dual read, format sniffing, precedence selection, and runtime authoring reads with positive source scans and mutation fixtures.

The old live file is deleted only after a restored managed process proves its declaration/argv uses `config.toml`, all listeners and old-sample replays pass, the Phase 4 AGY result is PASS, and a recoverable backup/hash has been recorded.

## Standalone exit evidence

- targeted Rust contract tests pass;
- positive and negative architecture fixtures pass;
- resource/function/mainline/module/verification maps resolve all declared symbols and paths;
- `git diff --check` passes;
- no runtime/default-path/live mutation occurred before standalone exit; explicit CLI/WebUI/lifecycle wiring begins only after that evidence is recorded.
