# Web search route exposure candidate evidence (2026-09-29)

Candidate base: `380dce73483246e082800519a04675b9c2910145`, combined with `origin/main` `79816eb49ec5251e45bf37b551c3d549eae5bfd0`. The current staged tree is the review target. This receipt records observed commands and results; it does not make an upstream search service availability claim.

## Source and integration

- `cargo test -p routecodex-v3-runtime` (from `v3/`): exit 0, including the GLM Anthropic wire, OpenAI Chat builtin tool, and Anthropic web search integration tests.
- `cargo test -p routecodex-v3-server --test multi_listener_server`: exit 0, 68 passed.
- `npm run verify:v3-architecture-ci`: exit 0, 39/39 sub-gates green.
- `cargo fmt --all -- --check` and `git diff --check`: exit 0.
- `npm run build:v3-cli`: exit 0; project version advanced to `0.90.4820`.

## Installed entry

- `npm run install:v3`: exit 0. Installed `rccv3` SHA-256 `f002116f6c8f0cca90f52eb7a3a2215051eebe29746cd33b822ff5e8f51e137f`, equal to candidate `v3/dist/bin/rccv3`.
- `rccv3 restart -c "$HOME/.rcc/config.toml"`: exit 0, managed instance `v3-48338a715d4c74610d91` returned `running`. Both port 4444 and port 7777 `/health` returned HTTP 200.
- Provider-request dry-run through port 7777 with `gpt-5.5`, builtin `web_search`, and ordinary `lookup`: selected `goaichat/glm-5.3`; provider tools contained only `lookup`.
- Same-entry dry-run through port 4444 with `gpt-5.5` and the same tools: selected `goaichat/deepseek-v4.1-flash`; provider tools contained only `lookup` because the selected model lacks search capability.
- Same-entry dry-run through port 4444 with direct-pinned `minimax_anthropic.MiniMax-M3` and the same tools: provider tools contained `web_search_20250305` and `lookup`.
- Live port 4444 `/v1/responses` request to direct-pinned MiniMax-M3 with builtin web search returned `status=completed`, with `web_search_call` and `function_call_output`; final text contained the repository URL.

The live response confirms this installed version can complete one search call; it does not prove all providers or future search requests succeed.
