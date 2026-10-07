import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PATCH_TOOL_NAME } from "./gcm-consumer-events.mjs";

const BOUND_HISTORY_FILES = [
  "request.json",
  "response.json",
  "provider-request.json",
  "provider-response.json",
];
const RESPONSE_HISTORY_FILES = new Set(["response.json", "provider-response.json"]);

export function bindSamples({ runtimeHome, port, threadId, startedAtMs }) {
  if (!threadId) {
    return { status: "UNVERIFIED", reason: "no_child_thread_id", port, matches: [] };
  }
  const portDir = path.join(runtimeHome, "codex-samples", "openai-responses", "ports", String(port));
  if (!fs.existsSync(portDir)) {
    return {
      status: "UNVERIFIED",
      reason: "port_directory_missing",
      port,
      port_dir: portDir,
      matches: [],
    };
  }

  const matches = [];
  for (const entry of fs.readdirSync(portDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sampleDir = path.join(portDir, entry.name);
    const requestPath = path.join(sampleDir, "request.json");
    if (!fs.existsSync(requestPath)) {
      continue;
    }
    const stat = fs.statSync(requestPath);
    if (stat.mtimeMs < startedAtMs - 5000) {
      continue;
    }
    let request;
    try {
      request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    } catch {
      continue;
    }
    const metadata = request?.client_metadata;
    const boundThreadId = metadata?.thread_id || metadata?.session_id;
    if (boundThreadId === threadId) {
      matches.push({
        request_id: entry.name,
        sample_dir: sampleDir,
        request_path: requestPath,
        mtime_ms: stat.mtimeMs,
        thread_id: metadata.thread_id || null,
        session_id: metadata.session_id || null,
      });
    }
  }
  matches.sort((left, right) => left.mtime_ms - right.mtime_ms);
  return {
    status: matches.length > 0 ? "bound" : "UNVERIFIED",
    reason: matches.length > 0 ? null : "no_exact_port_thread_request_binding",
    port,
    port_dir: portDir,
    match_field: "request.json:client_metadata.thread_id|session_id",
    thread_id: threadId,
    matches,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readBoundHistory(sampleBinding) {
  const entries = [];
  const errors = [];
  for (const match of sampleBinding.matches) {
    for (const fileName of BOUND_HISTORY_FILES) {
      const filePath = path.join(match.sample_dir, fileName);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        const stat = fs.statSync(filePath);
        entries.push({
          request_id: match.request_id,
          file: fileName,
          path: filePath,
          mtime_ms: stat.mtimeMs,
          value: readJson(filePath),
        });
      } catch (error) {
        errors.push({
          request_id: match.request_id,
          file: fileName,
          path: filePath,
          error: error.message,
        });
      }
    }
  }
  return { entries, errors };
}

function walkJson(value, visit, location = "$") {
  visit(value, location);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkJson(entry, visit, `${location}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walkJson(entry, visit, `${location}.${key}`);
    }
  }
}

function normalizePatchText(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n").replace(/\n$/, "") : null;
}

function functionPatchIdentity(argumentsValue) {
  let parsed = argumentsValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { text: parsed, form: "raw_string" };
    }
  }
  if (typeof parsed === "string") {
    return { text: parsed, form: "json_string" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return typeof parsed.patch === "string"
    ? { text: parsed.patch, form: "patch_member" }
    : null;
}

function findPatchCalls(historyEntries, rawPatch, allowExecPatch) {
  const expected = normalizePatchText(rawPatch);
  const calls = [];
  for (const entry of historyEntries) {
    walkJson(entry.value, (node, location) => {
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        return;
      }
      if (
        node.type === "custom_tool_call" &&
        node.name === PATCH_TOOL_NAME &&
        normalizePatchText(node.input) === expected
      ) {
        calls.push({
          request_id: entry.request_id,
          file: entry.file,
          location,
          type: node.type,
          name: node.name,
          argument_form: "input",
          call_id: node.call_id || null,
        });
        return;
      }
      const functionIdentity = functionPatchIdentity(node.arguments);
      if (
        node.type === "function_call" &&
        node.name === PATCH_TOOL_NAME &&
        normalizePatchText(functionIdentity?.text) === expected
      ) {
        calls.push({
          request_id: entry.request_id,
          file: entry.file,
          location,
          type: node.type,
          name: node.name,
          argument_form: functionIdentity.form,
          call_id: node.call_id || null,
        });
        return;
      }
      if (allowExecPatch && node.type === "function_call" && node.name === "exec_command") {
        let args;
        try {
          args = typeof node.arguments === "string" ? JSON.parse(node.arguments) : node.arguments;
        } catch {
          return;
        }
        const heredoc = typeof args?.cmd === "string"
          ? /^apply_patch <<(['"]?)([A-Za-z0-9_]+)\1\n([\s\S]+)\n\2$/.exec(args.cmd)
          : null;
        if (heredoc && normalizePatchText(heredoc[3]) === expected) {
          calls.push({
            request_id: entry.request_id,
            file: entry.file,
            location,
            type: node.type,
            name: node.name,
            argument_form: "exec_heredoc",
            call_id: node.call_id || null,
          });
        }
      }
    });
  }
  return calls;
}

function jsonContainsScalar(value, expected) {
  if (typeof expected === "string") {
    if (typeof value === "string") {
      if (value === expected) {
        return true;
      }
      try {
        return jsonContainsScalar(JSON.parse(value), expected);
      } catch {
        const envelope = /^Wall time: [^\n]+\nOutput:\n/.exec(value);
        if (!envelope) {
          return false;
        }
        try {
          return jsonContainsScalar(JSON.parse(value.slice(envelope[0].length)), expected);
        } catch {
          return false;
        }
      }
    }
  } else if (typeof expected === "number") {
    if (typeof value === "number" && Object.is(value, expected)) {
      return true;
    }
  } else if (typeof expected === "boolean") {
    if (typeof value === "boolean" && value === expected) {
      return true;
    }
  }
  if (Array.isArray(value)) {
    return value.some((entry) => jsonContainsScalar(entry, expected));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) => jsonContainsScalar(entry, expected));
  }
  return false;
}

export function validateBoundHistory(sampleBinding, addPatch, updatePatch, mcpCheck) {
  if (sampleBinding.status !== "bound") {
    return {
      ok: false,
      status: "UNVERIFIED",
      reason: "no exact port/thread sample binding",
      request_ids: [],
    };
  }

  const history = readBoundHistory(sampleBinding);
  if (history.errors.length > 0) {
    return {
      ok: false,
      status: "FAIL",
      reason: "bound history contains invalid JSON",
      request_ids: sampleBinding.matches.map((match) => match.request_id),
      read_errors: history.errors,
    };
  }

  const requestEntries = history.entries.filter((entry) => entry.file === "request.json");
  const responseEntries = history.entries.filter((entry) =>
    RESPONSE_HISTORY_FILES.has(entry.file),
  );
  const firstRequest = requestEntries[0] || null;
  let declaresNativePatch = false;
  walkJson(firstRequest?.value.tools ?? [], (node) => {
    if (node?.name === PATCH_TOOL_NAME && ["function", "custom"].includes(node.type)) {
      declaresNativePatch = true;
    }
  });
  const addCalls = findPatchCalls(history.entries, addPatch, !declaresNativePatch);
  const updateCalls = findPatchCalls(history.entries, updatePatch, !declaresNativePatch);
  const addIdentity = addCalls[0]
    ? { type: addCalls[0].type, name: addCalls[0].name }
    : null;
  const updateIdentity = updateCalls[0]
    ? { type: updateCalls[0].type, name: updateCalls[0].name }
    : null;
  const identityMatches =
    addIdentity !== null &&
    updateIdentity !== null &&
    addIdentity.type === updateIdentity.type &&
    addIdentity.name === updateIdentity.name;
  const observations = mcpCheck.structured_observations || [];
  const observationRequest = requestEntries.find((entry) => {
    if (!firstRequest || entry.mtime_ms <= firstRequest.mtime_ms || !Array.isArray(entry.value.input)) {
      return false;
    }
    return entry.value.input.some((call) => {
      if (call.type !== "function_call") {
        return false;
      }
      const callIdentityMatches =
        (call.namespace === `mcp__${mcpCheck.server}` && call.name === mcpCheck.tool) ||
        (!call.namespace && call.name === `mcp__${mcpCheck.server}__${mcpCheck.tool}`);
      if (!callIdentityMatches) {
        return false;
      }
      let args;
      try {
        args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
      } catch {
        return false;
      }
      if (!isDeepStrictEqual(args, mcpCheck.arguments)) {
        return false;
      }
      const output = entry.value.input.find(
        (item) => item.type === "function_call_output" && item.call_id === call.call_id,
      );
      return (
        output &&
        observations.every((observation) => jsonContainsScalar(output.output, observation.value))
      );
    });
  });
  const subsequentRequest =
    firstRequest &&
    observationRequest &&
    observationRequest.mtime_ms > firstRequest.mtime_ms
      ? observationRequest
      : null;
  const missingObservations = observations.filter(
    (observation) =>
      !subsequentRequest ||
      !jsonContainsScalar(subsequentRequest.value, observation.value),
  );
  const hasRequestHistory = requestEntries.length > 0;
  const hasResponseHistory = responseEntries.length > 0;
  const ok =
    hasRequestHistory &&
    hasResponseHistory &&
    addCalls.length > 0 &&
    updateCalls.length > 0 &&
    identityMatches &&
    observations.length > 0 &&
    subsequentRequest !== null &&
    missingObservations.length === 0;

  return {
    ok,
    status: ok ? "VERIFIED" : "FAIL",
    reason: ok
      ? null
      : "bound request/response history did not prove raw patch identity and subsequent MCP result consumption",
    request_ids: sampleBinding.matches.map((match) => match.request_id),
    files_read: history.entries.map((entry) => entry.path),
    request_history_count: requestEntries.length,
    response_history_count: responseEntries.length,
    add_patch_calls: addCalls,
    update_patch_calls: updateCalls,
    patch_identity: identityMatches ? addIdentity : null,
    subsequent_request: subsequentRequest
      ? {
          request_id: subsequentRequest.request_id,
          file: subsequentRequest.file,
          path: subsequentRequest.path,
          mtime_ms: subsequentRequest.mtime_ms,
        }
      : null,
    mcp_result_observations_missing_from_subsequent_requests: missingObservations.map(
      (observation) => ({
        location: observation.location,
        type: observation.type,
        value: observation.value,
      }),
    ),
  };
}
