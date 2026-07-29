#!/usr/bin/env node

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-responses-session-admission.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/session_admission.rs",
  "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
  "v3/crates/routecodex-v3-error/src/lib.rs",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests/v3.responses_session_admission.mainline.yml",
  "docs/architecture/manifests/v3.sse.http_keepalive.mainline.yml",
  "docs/architecture/wiki/v3-responses-session-admission.md",
  "docs/architecture/wiki/v3-sse-http-keepalive.md",
];
const cases = [
  {
    name: "conversation conflict is removed",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) =>
      source.replace(
        "                    || same_present_identity(&active.conversation_id, &scope.conversation_id))",
        ")",
      ),
    diagnostic: /Conflict must match either the explicit session or explicit conversation/u,
  },
  {
    name: "permit releases every active request",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) => source.replace(".remove(&token);", ".clear();"),
    diagnostic: /Permit drop must remove only its exact admission token/u,
  },
  {
    name: "request conflict is downgraded to 400",
    path: "v3/crates/routecodex-v3-error/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "V3ErrorSourceKind::RequestConflict => 409",
        "V3ErrorSourceKind::RequestConflict => 400",
      ),
    diagnostic: /Request conflict must project HTTP 409/u,
  },
  {
    name: "error SSE receives success keepalive",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "v3_client_sse_body(stream, false)",
        "v3_client_sse_body(stream, true)",
      ),
    diagnostic: /Error06\/foundation SSE must bypass success keepalive injection/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-session-admission-red-"));
  try {
    for (const relative of copied) {
      cpSync(resolve(repo, relative), resolve(root, relative), {
        recursive: true,
      });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, "utf8");
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0) {
      failures.push(`${testCase.name}: verifier unexpectedly passed`);
    } else if (!testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("[test:v3-responses-session-admission-red-fixtures] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-responses-session-admission-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
