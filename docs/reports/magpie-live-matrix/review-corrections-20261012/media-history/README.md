# Media history oracle correction (2026-10-12)

P1 Finding 3 repair evidence for the older-turn tool-image case. This is a
test-infrastructure correction only: no runtime Rust, operator, production
configuration, credential or lifecycle change is included.

## Provenance

- Fixed Magpie reference: `yetone/magpie` commit
  `bfaedf18301d02a423bd5422d22e41432d231ab8` (source test
  `internal/gateway/tool_images_test.go::TestOlderTurnToolResultImageKept`).
- Source candidate: `f7fc9e17b9a0f7fb66f3dc906c8808634e551334`.
- Installed binary: `/Users/fanzhang/.local/bin/rccv3`,
  `rccv3 0.90.4887 (crate 0.1.0)`, sha256
  `5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563`.
- Corpus fixture digest at run time:
  `0e9e06961603fb5148b86536dc035446de0c1a5c4a0ca98ae4be0eb78f49e353`.

## What changed

- The older-turn fixture now declares the complete six-message OpenAI Chat
  history (intervening assistant text at index 4, final user question at
  index 5) instead of a shifted subset.
- `v3/scripts/tests/protocol-live-mock/media-history.test.mjs` pins that history
  as one literal independent constant, checks it through the public
  `assertProviderCaptures` API, accepts the archived real capture, and adds
  negative controls for assistant deletion/reordering and broken tool-result
  pairing. It no longer derives the expectation from a converter.

## Evidence

- Node test `node --test v3/scripts/tests/protocol-live-mock/media-history.test.mjs`
  -> 4 pass, 0 fail, exit 0 (`media-history-node-test.log`).
- Real installed HTTP replay of the affected case passed: status `passed`,
  `provider_attempt_count` 1, client `200`, `complete` true, `response_ended`
  true, `error` null. Raw evidence under `live/`; report at `live-report.md`.
- Cleanup `complete: true`: owned RCC child exit observed (exit 0, not force
  killed), both listeners closed, mock closed, generated config state removed
  (`live/media-anthropic-older-turn-tool-image/setup.json`).

## Baseline preservation

The original raw baseline
(`../../installed-baseline-20261012/media-anthropic-older-turn-tool-image/provider-captures.json`,
sha256 `fd31ec9558d2141d27fe1983f7126f66b8673433a95756dce38767c8aedc2862`)
is unchanged and remains the read-only reference. That archived capture keeps
the intervening assistant turn and is now accepted by the corrected oracle; the
same oracle rejects a body with that turn removed.

## Boundary

No runtime source fix is claimed. The corrected oracle is test infrastructure;
if the provider body drops the assistant history or breaks tool-result pairing,
the affected case fails strictly.
