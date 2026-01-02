# Task: Regression Coverage Expansion & Mock Sample Program

## Objective
Build a reproducible regression suite that covers routing instructions, daemon/CLI flows, servertool backends, and every supported protocol (OpenAI Chat/Responses, Anthropic, Gemini) without hitting real upstream providers. All automated tests must run purely on local mock providers/sample replays and be tracked for CI readiness.

---

## Phase 1 – Sample Library & Playback Framework

- [ ] **Inventory existing samples**: audit `samples/mock-provider/_registry/index.json`, classify by protocol/entry endpoint/tag (owner: @me, due 2026‑01‑05).
- [ ] **Capture missing flows** (record once via mock collector scripts; use scrubbed payloads):
  - [ ] Anthropic `/v1/messages` (baseline + toolcall + SSE)
  - [ ] Gemini `/v1beta/models/*:generateContent` + Gemini CLI (toolcall + search-enabled)
  - [ ] Servertool `web_search` backend hits (GLM + Gemini) including fallback/error cases
  - [ ] CLI/daemon interactions (`routecodex daemon status/set routing`, token-daemon health) – capture via CLI mock log outputs
- [ ] **Registry metadata**: add tags per sample (`protocol=openai-responses`, `feature=web_search`, `error=auth`) so suites can select targeted subsets.
- [ ] **Automated validation**: extend `scripts/mock-provider/validate.mjs` to check new fields (`protocol`, `entryEndpoint`, `tags[]`) and verify each sample has matching request/response schema.
- [ ] **Playback harness**: generalize `run-regressions.mjs` to accept `--suite` filters (e.g., `routing`, `daemon`, `anthropic`) and spin up additional mock endpoints for anthropic/gemini/servertool when needed.

### Deliverables
1. Updated `_registry/index.json` with multi-protocol entries & tags
2. Replay harness supporting suite selection and multi-port mock servers
3. Documentation (`docs/mock-regressions.md`) describing how to capture/refresh samples

Progress: 0 / 5 subtasks done.

---

## Phase 2 – Automated Test Coverage

- [ ] **Routing/daemon integration tests** (Jest + child_process):
  - Simulate two sessions, apply `<**!provider**>`/`<**#provider**>` via user messages, verify daemon `status routing` reports isolated state and HTTP server honors overrides
  - Test `routecodex daemon set routing --server ... --session ...` to ensure CLI modifications hit correct sticky key
- [ ] **Servertool regression tests**:
  - Add Jest suite exercising web search: feed a conversation that triggers servertool, assert mock backend receives expected payload, verify tool result injection
  - Include scenarios for fallback (primary backend error → secondary) and disabled engines
- [ ] **Provider transport tests without real upstream**:
  - Replace existing HTTP calls in provider tests with local stub server (nock or custom express) so authentication/errors are controllable
  - Cover error ladders (401, 429, 5xx) to ensure Virtual Router health mapper is exercised
- [ ] **Monitoring/semantic tracker tests**: ensure sample snapshots track system instructions, tool calls, token usage across protocols using mock payloads
- [ ] **CLI smoke tests**: script to run `routecodex --version`, `routecodex daemon status routing`, `routecodex token-daemon status` against mock env to guarantee CLI entry points never regress

### Deliverables
1. `tests/integration/routing-daemon.spec.ts`
2. `tests/servertool/web-search-regression.spec.ts`
3. Provider transport tests using mock HTTP server (no real API keys)
4. CLI smoke test scripts integrated with Jest or standalone Node harness

Progress: 0 / 5 subtasks done.

---

## Phase 3 – CI Pipeline & Reporting

- [ ] **Unified `npm run test:ci`** combining:
  1. Unit/integration Jest suites (including new routing/daemon/servertool tests)
  2. `mock:regressions --suite all` playback
  3. Lint/static checks (optional but recommended)
- [ ] **Result reporting**: produce JSON summary (pass/fail counts per suite & sample tags) stored under `test-results/` for CI artifact upload
- [ ] **GitHub Actions workflow**: add `ci.yml` running on push/PR, caching dependencies, invoking `npm run test:ci`, publishing mock regression summary
- [ ] **Flake mitigation**: ensure scripts respect `ROUTECODEX_VERIFY_SKIP=1` and avoid network access (document required env vars)

Progress: 0 / 3 subtasks done.

---

## Tracking & Updates

- Status updates will be appended here with dates + brief notes.
- Each phase completion will include a checklist review and links to relevant PRs/docs.
