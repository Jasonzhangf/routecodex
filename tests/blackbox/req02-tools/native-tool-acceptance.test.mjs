#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = process.env.REQ02_HARNESS_DIR
  ? path.resolve(process.env.REQ02_HARNESS_DIR)
  : testDir;
const { validateExec } = await import(
  pathToFileURL(path.join(harnessDir, "gcm-consumer-events.mjs")).href
);
const { validateBoundHistory } = await import(
  pathToFileURL(path.join(harnessDir, "gcm-consumer-history.mjs")).href
);

const PATCH_MARK = "*** ";
const testedWorktree = "/Volumes/Intel/playground/routecodex/req02-split-gcm55-20261006-r157";
const sentinel = "REQ02_GCM_EXEC_SENTINEL_gpt-5.5-2026-10-07-003744809-62230-c9a164bd";
const execCommand = `/bin/zsh -c "pwd
printf '%s\\\\n' 'REQ02_GCM_EXEC_BEGIN'
printf '%s\\\\n' 'REQ02_GCM_EXEC_END'
printf '%s\\\\n' '${sentinel}'"`;
const completeExecOutput = `${testedWorktree}
REQ02_GCM_EXEC_BEGIN
REQ02_GCM_EXEC_END
${sentinel}
`;

const addPatch = `${PATCH_MARK}Begin Patch
${PATCH_MARK}Add File: .req02-gcm-consumer/gpt-5.5-2026-10-07-003744809-62230-c9a164bd/marker.txt
+REQ02_GCM_PATCH_INITIAL
${PATCH_MARK}End Patch`;
const updatePatch = `${PATCH_MARK}Begin Patch
${PATCH_MARK}Update File: .req02-gcm-consumer/gpt-5.5-2026-10-07-003744809-62230-c9a164bd/marker.txt
@@
-REQ02_GCM_PATCH_INITIAL
+REQ02_GCM_PATCH_UPDATED
${PATCH_MARK}End Patch`;
const mcpArguments = {
  view: "current",
  workspace: "routecodex",
  sections: ["runtime", "os"],
};
const mcpCheck = {
  server: "mcpx",
  tool: "environment_read",
  arguments: mcpArguments,
  structured_observations: [
    {
      location: "/data/runtime/mcpx_version",
      type: "string",
      value: "0.9.18",
      text: "0.9.18",
    },
    {
      location: "/data/os/type",
      type: "string",
      value: "darwin",
      text: "darwin",
    },
  ],
};

function commandEntry(output, exitCode = 0) {
  return {
    event: {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        status: "completed",
        command: execCommand,
        aggregated_output: output,
        exit_code: exitCode,
      },
    },
    index: 0,
  };
}

const failures = [];

function check(name, actual, expected) {
  if (actual !== expected) {
    failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setMtime(filePath, mtimeMs) {
  const timestamp = new Date(mtimeMs);
  fs.utimesSync(filePath, timestamp, timestamp);
}

function nativePatchNode(identity, patch, callId) {
  if (identity === "custom_tool_call") {
    return {
      type: "custom_tool_call",
      name: "apply_patch",
      input: patch,
      call_id: callId,
    };
  }
  return {
    type: "function_call",
    name: "apply_patch",
    arguments: JSON.stringify({ patch }),
    call_id: callId,
  };
}

function heredocPatchNode(patch, tag, callId) {
  return {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: `apply_patch <<'${tag}'\n${patch}\n${tag}`,
    }),
    call_id: callId,
  };
}

function mcpFunctionCall() {
  return {
    type: "function_call",
    name: "mcp__mcpx__environment_read",
    arguments: JSON.stringify(mcpArguments),
    call_id: "call_mcp_followup",
  };
}

function mcpFunctionOutput() {
  return {
    type: "function_call_output",
    call_id: "call_mcp_followup",
    output: JSON.stringify({
      data: {
        runtime: { mcpx_version: "0.9.18" },
        os: { type: "darwin" },
      },
    }),
  };
}

function makeBoundHistoryFixture({ tools, addNode, updateNode }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "req02-native-harness-"));
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });

  const firstRequestPath = path.join(firstDir, "request.json");
  const firstResponsePath = path.join(firstDir, "response.json");
  const secondRequestPath = path.join(secondDir, "request.json");

  writeJson(firstRequestPath, {
    tools,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "run the acceptance command" }],
      },
    ],
  });
  writeJson(firstResponsePath, {
    materializedResponse: {
      output: [addNode],
    },
  });
  writeJson(secondRequestPath, {
    input: [
      addNode,
      updateNode,
      mcpFunctionCall(),
      mcpFunctionOutput(),
    ],
  });

  setMtime(firstRequestPath, 1_700_000_000_000);
  setMtime(firstResponsePath, 1_700_000_001_000);
  setMtime(secondRequestPath, 1_700_000_002_000);

  return {
    sampleBinding: {
      status: "bound",
      port: 45559,
      matches: [
        {
          request_id: "first-request",
          sample_dir: firstDir,
          request_path: firstRequestPath,
          mtime_ms: 1_700_000_000_000,
          thread_id: "thread-r237",
          session_id: "thread-r237",
        },
        {
          request_id: "second-request",
          sample_dir: secondDir,
          request_path: secondRequestPath,
          mtime_ms: 1_700_000_002_000,
          thread_id: "thread-r237",
          session_id: "thread-r237",
        },
      ],
    },
    root,
  };
}

const execFailures = [
  {
    name: "missing cwd",
    output: `REQ02_GCM_EXEC_BEGIN
REQ02_GCM_EXEC_END
${sentinel}
`,
  },
  {
    name: "missing BEGIN",
    output: `${testedWorktree}
REQ02_GCM_EXEC_END
${sentinel}
`,
  },
  {
    name: "missing END",
    output: `${testedWorktree}
REQ02_GCM_EXEC_BEGIN
${sentinel}
`,
  },
  {
    name: "missing sentinel",
    output: `${testedWorktree}
REQ02_GCM_EXEC_BEGIN
REQ02_GCM_EXEC_END
`,
  },
  {
    name: "wrong order",
    output: `${testedWorktree}
REQ02_GCM_EXEC_END
REQ02_GCM_EXEC_BEGIN
${sentinel}
`,
  },
  {
    name: "extra output line",
    output: `${testedWorktree}
REQ02_GCM_EXEC_BEGIN
unexpected
REQ02_GCM_EXEC_END
${sentinel}
`,
  },
];

check(
  "complete native exec output",
  validateExec([commandEntry(completeExecOutput)], testedWorktree, sentinel).ok,
  true,
);

for (const failure of execFailures) {
  check(
    `exec output rejects ${failure.name}`,
    validateExec([commandEntry(failure.output)], testedWorktree, sentinel).ok,
    false,
  );
}

const nativeTools = [{ type: "custom", name: "apply_patch" }];
const nativeFixture = makeBoundHistoryFixture({
  tools: nativeTools,
  addNode: nativePatchNode("custom_tool_call", addPatch, "call_add"),
  updateNode: nativePatchNode("custom_tool_call", updatePatch, "call_update"),
});
const nativeResult = validateBoundHistory(
  nativeFixture.sampleBinding,
  addPatch,
  updatePatch,
  mcpCheck,
);
check("native custom Add/Update plus MCP follow-up", nativeResult.ok, true);
check(
  "native custom patch identity",
  nativeResult.patch_identity?.type,
  "custom_tool_call",
);

const nativeFunctionFixture = makeBoundHistoryFixture({
  tools: [{ type: "function", name: "apply_patch" }],
  addNode: nativePatchNode("function_call", addPatch, "call_add"),
  updateNode: nativePatchNode("function_call", updatePatch, "call_update"),
});
const nativeFunctionResult = validateBoundHistory(
  nativeFunctionFixture.sampleBinding,
  addPatch,
  updatePatch,
  mcpCheck,
);
check("native function Add/Update plus MCP follow-up", nativeFunctionResult.ok, true);
check(
  "native function patch identity",
  nativeFunctionResult.patch_identity?.type,
  "function_call",
);

const heredocFixture = makeBoundHistoryFixture({
  tools: [],
  addNode: heredocPatchNode(addPatch, "PATCH_ADD", "call_add"),
  updateNode: heredocPatchNode(updatePatch, "PATCH_UPDATE", "call_update"),
});
const heredocResult = validateBoundHistory(
  heredocFixture.sampleBinding,
  addPatch,
  updatePatch,
  mcpCheck,
);
check("exec heredoc-only patch", heredocResult.ok, false);

const undeclaredNativeFixture = makeBoundHistoryFixture({
  tools: [],
  addNode: nativePatchNode("custom_tool_call", addPatch, "call_add"),
  updateNode: nativePatchNode("function_call", updatePatch, "call_update"),
});
const undeclaredNativeResult = validateBoundHistory(
  undeclaredNativeFixture.sampleBinding,
  addPatch,
  updatePatch,
  mcpCheck,
);
check(
  "native calls without native declaration",
  undeclaredNativeResult.ok,
  false,
);

const mismatchedDeclarationFixture = makeBoundHistoryFixture({
  tools: [{ type: "custom", name: "apply_patch" }],
  addNode: nativePatchNode("function_call", addPatch, "call_add"),
  updateNode: nativePatchNode("function_call", updatePatch, "call_update"),
});
const mismatchedDeclarationResult = validateBoundHistory(
  mismatchedDeclarationFixture.sampleBinding,
  addPatch,
  updatePatch,
  mcpCheck,
);
check(
  "native call identity matches declaration",
  mismatchedDeclarationResult.ok,
  false,
);

for (const fixture of [
  nativeFixture,
  nativeFunctionFixture,
  heredocFixture,
  undeclaredNativeFixture,
  mismatchedDeclarationFixture,
]) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("native-tool acceptance consumer tests passed\n");
}
