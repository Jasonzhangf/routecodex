#!/usr/bin/env node

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { buildPrompt } from "./gcm-consumer-runner.mjs";

const mcpArguments = {
  view: "current",
  workspace: "routecodex",
  sections: ["runtime", "os"],
};
const exactArguments = JSON.stringify(mcpArguments);
const addPatch = `*** Begin Patch
*** Add File: .req02-gcm-consumer/exact-mcp-prompt/marker.txt
+REQ02_GCM_PATCH_INITIAL
*** End Patch`;
const updatePatch = `*** Begin Patch
*** Update File: .req02-gcm-consumer/exact-mcp-prompt/marker.txt
@@
-REQ02_GCM_PATCH_INITIAL
+REQ02_GCM_PATCH_UPDATED
*** End Patch`;

// Synthetic, portable inputs. They are rendered into the prompt but not written
// to disk, so the test does not pin a historical worktree or candidate SHA.
const testedWorktree = path.join(os.tmpdir(), "req02-exact-mcp-prompt", "worktree");
const markerFile = path.join(
  testedWorktree,
  ".req02-gcm-consumer",
  "exact-mcp-prompt",
  "marker.txt",
);
const markerUpdated = "REQ02_GCM_PATCH_UPDATED\n";
const markerSha256 = createHash("sha256").update(markerUpdated).digest("hex");

const prompt = buildPrompt({
  endpoint: "http://127.0.0.1:45559/v1",
  candidateSha: "0".repeat(40),
  model: "gpt-5.5",
  testedWorktree,
  markerFile,
  markerInitial: "REQ02_GCM_PATCH_INITIAL\n",
  markerUpdated,
  markerSha256,
  sentinel: "REQ02_GCM_EXEC_SENTINEL_EXACT_MCP_PROMPT",
  mcpServer: "mcpx",
  mcpTool: "environment_read",
  mcpArguments,
  mcpObservationPointers: ["/data/runtime/mcpx_version", "/data/os/type"],
  addPatch,
  updatePatch,
});

const failures = [];

function contains(label, value) {
  if (!prompt.includes(value)) {
    failures.push(`${label}: expected prompt to contain ${JSON.stringify(value)}`);
  }
}

function notContains(label, value) {
  if (prompt.includes(value)) {
    failures.push(`${label}: expected prompt not to contain ${JSON.stringify(value)}`);
  }
}

contains("exact MCP arguments", exactArguments);
contains("read-only MCP step", "read-only MCP");
contains("exact arguments unchanged", "arguments exactly as shown above");
contains("no activity added", "Do not add 'activity'");
contains("no session id added", "'remote_session_id'");
contains("no session substitute", "Do not open a session as a substitute");
contains("existing tool discovery", "tool-discovery step");
contains("direct real MCP call", "the direct call above is required");
contains("structured MCP result", "Retain the\nstructured result");
contains("unchanged exec command", "REQ02_GCM_EXEC_BEGIN");
contains("unchanged Add patch", addPatch);
contains("unchanged Update patch", updatePatch);
contains("no fabricated output", "Do not fabricate tool output");
notContains("no MCP skip instruction", "skip the MCP");
contains("discovery cannot replace direct call", "never a substitute");

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("exact MCP prompt regression tests passed\n");
}
