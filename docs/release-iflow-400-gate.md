# iflow 400 Fix Release Gate (llms -> rcc)

Date: 2026-02-15
Issue: routecodex-75
Prerequisite bug: routecodex-70 (CLOSED)

## 1) Preconditions
- routecodex-70 is closed with replay evidence.
- Matching tags exist on both repos:
  - `rc-v0.6.1733-v0.89.1798`
  - `rc-v0.6.1733-v0.89.1799`
- Artifacts prepared:
  - `/tmp/jsonstudio-llms-0.6.1733.tgz`
  - `jsonstudio-rcc-0.89.1799.tgz`

## 2) Mandatory verification gate
1. Same-shape replay (affected provider: iflow)
- sample: `req_1770377342669_6d3e332c`
- expected: HTTP 200, no 514 business error

2. Control replay (unaffected provider)
- sample: `req_1770381056958_a35ee9ff` (tab)
- expected: HTTP 200, behavior unchanged

3. Runtime/build checks
- `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor-provider.spec.ts tests/server/runtime/executor-provider.retryable.spec.ts --runInBand`
- `npm run jest:run -- --runTestsByPath tests/server/runtime/request-executor.single-attempt.spec.ts tests/server/http-server/execute-pipeline-failover.spec.ts --runInBand`
- `npm run build:dev`
- `npm run install:global`

## 3) Publish order (manual)
1. Publish llms first
- `cd sharedmodule/llmswitch-core`
- `npm publish /tmp/jsonstudio-llms-0.6.1733.tgz`

2. Verify rcc package depends on published llms version
- `cd /Users/fanzhang/Documents/github/routecodex`
- check `package.json` has `@jsonstudio/llms: 0.6.1733`

3. Publish rcc
- `npm publish jsonstudio-rcc-0.89.1799.tgz`

## 4) Rollback checklist
- If llms publish breaks replay gate:
  1. stop rcc publish
  2. rollback to previous llms version in routecodex package.json
  3. rebuild + rerun same-shape/control replays

- If rcc publish breaks runtime:
  1. pin users back to previous rcc version
  2. collect failing requestId/providerKey/model
  3. preserve same-shape/control replay outputs

## 5) Evidence references
- routecodex-70 notes include request-level replay outputs:
  - `/tmp/replay-iflow-base-req_1770377342669_6d3e332c.txt`
  - `/tmp/replay-iflow-stop-followup-20260207T100636992-003.withkey.txt`
  - `/tmp/replay-control-tab-key1.req_1770381056958_a35ee9ff.txt`
