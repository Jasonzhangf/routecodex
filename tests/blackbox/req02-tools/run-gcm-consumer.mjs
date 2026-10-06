#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const PROFILE = "gcm";
const MODELS = new Set(["gpt-5.5", "gpt-5.6"]);
const PATCH_TOOL_NAME = "apply_patch";
const SCHEMA = "req02-gcm-consumer-summary-v1";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const BOUND_HISTORY_FILES = [
  "request.json",
  "response.json",
  "provider-request.json",
  "provider-response.json",
];
const RESPONSE_HISTORY_FILES = new Set(["response.json", "provider-response.json"]);

const USAGE = `REQ02 GCM consumer harness

Usage:
  node tests/blackbox/req02-tools/run-gcm-consumer.mjs [options]

Required:
  --endpoint <url>          Isolated candidate base URL, for example
                            http://127.0.0.1:5555/v1
  --candidate-sha <sha>     Full 40-hex candidate commit SHA
  --binary <path>           Absolute candidate binary path
  --binary-sha256 <sha>     Full 64-hex SHA-256 of that binary
  --model <model>           gpt-5.5 or gpt-5.6
  --tested-worktree <path>  Absolute clean/tested worktree whose HEAD is
                            the candidate SHA
  --evidence-dir <path>     Absolute evidence output directory
  --mcp-server <name>       Exact MCP server name (recommended: mcpx)
  --mcp-tool <name>         Exact MCP tool name (recommended: runtime_read)
  --mcp-arguments <json>    Exact JSON object arguments (recommended:
                            '{"view":"capabilities"}')
  --mcp-observation-pointers <json>
                            JSON pointer array of result values the model must
                            consume, for example ["/data/runtime/version"]

Optional:
  --codex-bin <path>        Codex CLI executable (default: codex)
  --timeout-ms <ms>         Child timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help                Print this help and exit

The harness refuses port 4444. It reads the active $CODEX_HOME/gcm.config.toml
and the base config, resolves the actual provider id, and passes a child CLI
override for model_providers.<provider-id>.base_url. It never edits the global
config and never prints auth/token values.
`;

function printUsage(stream = process.stdout) {
  stream.write(USAGE);
}

function parseArgs(argv) {
  const options = {
    codexBin: "codex",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const errors = [];
  const valueOptions = new Map([
    ["--endpoint", "endpoint"],
    ["--candidate-sha", "candidateSha"],
    ["--binary", "binary"],
    ["--binary-sha256", "binarySha256"],
    ["--model", "model"],
    ["--tested-worktree", "testedWorktree"],
    ["--evidence-dir", "evidenceDir"],
    ["--mcp-server", "mcpServer"],
    ["--mcp-tool", "mcpTool"],
    ["--mcp-arguments", "mcpArguments"],
    ["--mcp-observation-pointers", "mcpObservationPointers"],
    ["--codex-bin", "codexBin"],
    ["--timeout-ms", "timeoutMs"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options, errors };
    }
    if (!arg.startsWith("--")) {
      errors.push(`unexpected positional argument: ${arg}`);
      continue;
    }

    let name = arg;
    let value;
    const equalsAt = arg.indexOf("=");
    if (equalsAt >= 0) {
      name = arg.slice(0, equalsAt);
      value = arg.slice(equalsAt + 1);
    }
    const target = valueOptions.get(name);
    if (!target) {
      errors.push(`unknown option: ${name}`);
      continue;
    }
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") {
      errors.push(`missing value for ${name}`);
      continue;
    }
    options[target] = value;
  }

  const required = [
    ["endpoint", "--endpoint"],
    ["candidateSha", "--candidate-sha"],
    ["binary", "--binary"],
    ["binarySha256", "--binary-sha256"],
    ["model", "--model"],
    ["testedWorktree", "--tested-worktree"],
    ["evidenceDir", "--evidence-dir"],
    ["mcpServer", "--mcp-server"],
    ["mcpTool", "--mcp-tool"],
    ["mcpArguments", "--mcp-arguments"],
    ["mcpObservationPointers", "--mcp-observation-pointers"],
  ];
  for (const [key, flag] of required) {
    if (!options[key]) {
      errors.push(`missing required option: ${flag}`);
    }
  }

  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    errors.push("--timeout-ms must be a positive integer");
  } else {
    options.timeoutMs = timeoutMs;
  }

  if (options.mcpArguments) {
    try {
      const parsed = JSON.parse(options.mcpArguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("--mcp-arguments must be a JSON object");
      } else {
        options.mcpArguments = parsed;
      }
    } catch (error) {
      errors.push(`--mcp-arguments is not valid JSON: ${error.message}`);
    }
  }

  if (options.mcpObservationPointers) {
    try {
      const pointers = JSON.parse(options.mcpObservationPointers);
      if (!Array.isArray(pointers) || pointers.length === 0 ||
          pointers.some(pointer => typeof pointer !== "string" || !pointer.startsWith("/"))) {
        errors.push("--mcp-observation-pointers must be a non-empty JSON pointer array");
      } else {
        options.mcpObservationPointers = pointers;
      }
    } catch (error) {
      errors.push(`--mcp-observation-pointers is not valid JSON: ${error.message}`);
    }
  }
  return { help: false, options, errors };
}

function fail(message) {
  throw new Error(message);
}

function assertAbsolute(filePath, label) {
  if (!path.isAbsolute(filePath)) {
    fail(`${label} must be an absolute path: ${filePath}`);
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`${label} is not a file: ${filePath}`);
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Text(text) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    fail(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function stripTomlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function normalizeTomlKey(raw) {
  return raw
    .split(".")
    .map((part) => {
      const value = part.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        return JSON.parse(value);
      }
      if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1);
      }
      return value;
    })
    .join(".");
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function parseTomlValues(text) {
  const values = new Map();
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = normalizeTomlKey(sectionMatch[1]);
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt < 0) {
      continue;
    }
    const key = normalizeTomlKey(line.slice(0, equalsAt));
    const fullKey = section ? `${section}.${key}` : key;
    values.set(fullKey, parseTomlScalar(line.slice(equalsAt + 1)));
  }
  return values;
}

function loadProfileTruth(sourceHome) {
  const baseConfig = path.join(sourceHome, "config.toml");
  const profileConfig = path.join(sourceHome, `${PROFILE}.config.toml`);
  assertFile(baseConfig, "base Codex config");
  assertFile(profileConfig, `${PROFILE} profile config`);

  const base = parseTomlValues(fs.readFileSync(baseConfig, "utf8"));
  const profile = parseTomlValues(fs.readFileSync(profileConfig, "utf8"));
  const providerId = profile.get("model_provider") ?? base.get("model_provider");
  if (!providerId) {
    fail(`could not resolve model_provider from ${profileConfig} or ${baseConfig}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
    fail(`provider id is not a bare TOML key, refusing to guess an override path: ${providerId}`);
  }

  const providerKey = `model_providers.${providerId}.base_url`;
  const profileBaseUrl = profile.get(providerKey);
  const baseBaseUrl = base.get(providerKey);
  const profileBaseUrlSource = profileBaseUrl ? profileConfig : null;
  const baseUrl = profileBaseUrl ?? baseBaseUrl;
  if (!baseUrl) {
    fail(`could not resolve ${providerKey} from ${profileConfig} or ${baseConfig}`);
  }

  return {
    providerId,
    baseUrl,
    baseUrlSource: profileBaseUrlSource ?? baseConfig,
    profileConfig,
    baseConfig,
    providerSource: profile.has("model_provider") ? profileConfig : baseConfig,
  };
}

function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail(`--endpoint is not a valid absolute URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`--endpoint must use http or https: ${endpoint}`);
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port === 4444) {
    fail("refusing the shared 4444 endpoint; pass an isolated candidate endpoint");
  }
  return {
    url,
    endpoint: endpoint.replace(/\/+$/, ""),
    port,
  };
}

function resolveExecutable(command) {
  if (path.isAbsolute(command)) {
    if (!fs.existsSync(command)) {
      fail(`executable does not exist: ${command}`);
    }
    return command;
  }
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry || ".", command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  fail(`executable not found on PATH: ${command}`);
}

function inspectCodexCli(codexBin) {
  const versionResult = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    path: codexBin,
    version: (versionResult.stdout || "").trim() || null,
    version_exit_code: versionResult.status,
    version_error: versionResult.error ? versionResult.error.message : null,
  };
}

function createIsolatedHome(sourceHome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "req02-gcm-consumer-"));
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home, { recursive: true });

  const requiredLinks = ["config.toml", `${PROFILE}.config.toml`, "auth.json"];
  for (const name of requiredLinks) {
    const source = path.join(sourceHome, name);
    assertFile(source, `source CODEX_HOME ${name}`);
    fs.symlinkSync(source, path.join(home, name));
  }
  const sourceAgents = path.join(sourceHome, "AGENTS.md");
  if (fs.existsSync(sourceAgents)) {
    fs.symlinkSync(sourceAgents, path.join(home, "AGENTS.md"));
  }

  return { root, home };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPrompt(input) {
  const markerRelative = path.relative(input.testedWorktree, input.markerFile);
  const sentinel = input.sentinel;
  const initial = input.markerInitial.trimEnd();
  const updated = input.markerUpdated.trimEnd();
  const markerAbsolute = input.markerFile;
  const worktree = input.testedWorktree;
  const markerSha = input.markerSha256;
  const mcpServer = input.mcpServer;
  const mcpTool = input.mcpTool;
  const mcpArguments = JSON.stringify(input.mcpArguments);

  return `You are the REQ02 GCM consumer for one isolated candidate endpoint.

Inputs:
- candidate_endpoint: ${input.endpoint}
- candidate_sha: ${input.candidateSha}
- model: ${input.model}
- tested_worktree: ${worktree}
- marker_file_relative: ${markerRelative}
- marker_file_absolute: ${markerAbsolute}
- marker_initial: ${initial}
- marker_updated: ${updated}
- expected_marker_sha256_after_update: ${markerSha}
- exec_sentinel: ${sentinel}
- mcp_server: ${mcpServer}
- mcp_tool: ${mcpTool}
- mcp_observation_pointers: ${JSON.stringify(input.mcpObservationPointers)}
- mcp_arguments: ${mcpArguments}

Perform these actions for real. Do not merely describe them.

1. Call exec_command with workdir exactly ${worktree}. Run this complete
multi-line shell command and preserve its output:

  pwd
  printf '%s\\n' 'REQ02_GCM_EXEC_BEGIN'
  printf '%s\\n' 'REQ02_GCM_EXEC_END'
  printf '%s\\n' '${sentinel}'

The last non-empty output line must be exactly:
  ${sentinel}

2. Call the native apply_patch tool with freeform text. Add the marker file:

${input.addPatch}

3. Call the native apply_patch tool with freeform text again. Update the same
marker file:

${input.updatePatch}

4. Call exec_command with workdir exactly ${worktree}. Run this complete
multi-line shell command and preserve its output:

  printf '%s\\n' 'REQ02_GCM_MARKER_BEGIN'
  cat ${shellQuote(markerAbsolute)}
  wc -c < ${shellQuote(markerAbsolute)}
  shasum -a 256 ${shellQuote(markerAbsolute)}
  printf '%s\\n' 'REQ02_GCM_MARKER_END'

5. Call the real read-only MCP server ${mcpServer} tool ${mcpTool} with the
exact JSON arguments ${mcpArguments}. Do not use tool discovery as a
substitute. Retain the structured result.

6. Final response must be plain text and must include these exact observed
values, not claimed values:

  EXEC_SENTINEL=${sentinel}
  PATCH_CONTENT=${updated}
  PATCH_SHA256=<the 64-hex SHA-256 observed from the marker read-back>
  MCP_SERVER=${mcpServer}
  MCP_TOOL=${mcpTool}
  MCP_RESULT=<the actual values at each configured mcp_observation_pointer>

Constraints:
- Write only ${markerAbsolute} and its parent directory.
- Do not modify product files, configuration, global state, or another
  worktree.
- Do not use resume, fork, a parent transcript, or an implicit session.
- Do not fabricate tool output. If a required action fails, report the exact
  failure and stop.`;
}

function parseJsonl(buffer) {
  const events = [];
  const parseErrors = [];
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message });
    }
  }
  return { events, parseErrors };
}

function itemEvents(events) {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.item);
}

function completedItem(entry) {
  return entry.event.type === "item.completed" && entry.event.item?.status === "completed";
}

function findCommandItem(entries, predicate) {
  return entries.find((entry) => {
    if (!completedItem(entry) || entry.event.item?.type !== "command_execution") {
      return false;
    }
    return predicate(entry.event.item, entry.index);
  });
}

function findFileChangeItem(entries, predicate) {
  return entries.find((entry) => {
    if (!completedItem(entry) || entry.event.item?.type !== "file_change") {
      return false;
    }
    return predicate(entry.event.item, entry.index);
  });
}

function validateExec(entries, testedWorktree, sentinel) {
  const found = findCommandItem(entries, (item) => {
    const command = item.command || "";
    const output = item.aggregated_output || "";
    return (
      item.exit_code === 0 &&
      command.includes(sentinel) &&
      command.includes("\n") &&
      output.includes(sentinel) &&
      output.includes(testedWorktree)
    );
  });
  if (!found) {
    return { ok: false, reason: "no completed exec_command receipt with the sentinel and absolute worktree" };
  }
  const item = found.event.item;
  const output = item.aggregated_output || "";
  const lastLine = output.trimEnd().split(/\r?\n/).at(-1);
  if (lastLine !== sentinel) {
    return { ok: false, reason: `exec output does not end with sentinel: ${lastLine}` };
  }
  return {
    ok: true,
    item_id: item.id,
    command: item.command,
    output: item.aggregated_output,
    exit_code: item.exit_code,
  };
}

function validatePatch(
  entries,
  markerRelative,
  markerInitial,
  markerUpdated,
  markerSha256,
  markerByteLength,
) {
  const hasOnlyChange = (item, expectedPath, expectedKind) =>
    Array.isArray(item.changes) &&
    item.changes.length === 1 &&
    item.changes[0]?.path === expectedPath &&
    item.changes[0]?.kind === expectedKind;
  const add = findFileChangeItem(
    entries,
    (item) => hasOnlyChange(item, markerRelative, "add"),
  );
  const update = findFileChangeItem(
    entries,
    (item, index) =>
      index > (add?.index ?? -1) && hasOnlyChange(item, markerRelative, "update"),
  );
  if (!add || !update || update.index <= add.index) {
    return {
      ok: false,
      reason: "missing ordered completed native file_change Add then Update receipts",
    };
  }

  const readback = findCommandItem(
    entries,
    (item, index) => {
      if (
        index <= update.index ||
        item.exit_code !== 0 ||
        !(item.command || "").includes("wc -c") ||
        !(item.command || "").includes("shasum -a 256")
      ) {
        return false;
      }
      const lines = (item.aggregated_output || "").trimEnd().split(/\r?\n/);
      const begin = lines.indexOf("REQ02_GCM_MARKER_BEGIN");
      const end = lines.indexOf("REQ02_GCM_MARKER_END", begin + 1);
      if (begin < 0 || end !== begin + 4 || lines.length !== end + 1) {
        return false;
      }
      return (
        lines[begin + 1] === markerUpdated &&
        lines[begin + 2].trim() === String(markerByteLength) &&
        lines[begin + 3].trim().startsWith(markerSha256)
      );
    },
  );
  if (!readback) {
    return {
      ok: false,
      reason: "missing completed marker read-back with bytes, content, and SHA-256",
    };
  }

  return {
    ok: true,
    add_item_id: add.event.item.id,
    update_item_id: update.event.item.id,
    add_changes: add.event.item.changes,
    update_changes: update.event.item.changes,
    readback_item_id: readback.event.item.id,
    readback_command: readback.event.item.command,
    readback_output: readback.event.item.aggregated_output,
  };
}

function collectStructuredObservations(value, pointers) {
  return pointers.flatMap(location => {
    let observed = value;
    for (const token of location.slice(1).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (observed === null || typeof observed !== "object" ||
          !Object.prototype.hasOwnProperty.call(observed, key)) return [];
      observed = observed[key];
    }
    if (observed === undefined || typeof observed === "object") return [];
    return [{ location, type: typeof observed, value: observed,
      text: typeof observed === "string" ? observed : JSON.stringify(observed) }];
  });
}

function validateMcp(entries, expectedServer, expectedTool, expectedArguments, observationPointers) {
  const found = entries.find(
    (entry) =>
      entry.event.type === "item.completed" &&
      entry.event.item?.type === "mcp_tool_call" &&
      entry.event.item?.status === "completed" &&
      entry.event.item?.server === expectedServer &&
      entry.event.item?.tool === expectedTool &&
      isDeepStrictEqual(entry.event.item?.arguments, expectedArguments) &&
      !entry.event.item?.error &&
      entry.event.item?.result &&
      typeof entry.event.item.result.structured_content === "object" &&
      entry.event.item.result.structured_content !== null &&
      collectStructuredObservations(entry.event.item.result.structured_content, observationPointers).length === observationPointers.length,
  );
  if (!found) {
    return {
      ok: false,
      reason: `no completed structured ${expectedServer}.${expectedTool} call with the exact explicit arguments`,
    };
  }
  return {
    ok: true,
    item_id: found.event.item.id,
    server: found.event.item.server,
    tool: found.event.item.tool,
    arguments: found.event.item.arguments,
    structured_content: found.event.item.result.structured_content,
    structured_observations: collectStructuredObservations(
      found.event.item.result.structured_content,
      observationPointers,
    ),
  };
}

function validateModelConsumption(events, sentinel, markerUpdated, markerSha256, mcp, mcpServer, mcpTool) {
  const messages = events
    .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text || "");
  const text = messages.at(-1) || "";
  const observations = mcp.structured_observations || [];
  const consumedObservations = observations.filter((observation) =>
    text.includes(observation.text),
  );
  const ok =
    text.includes(sentinel) &&
    text.includes(markerUpdated) &&
    text.includes(markerSha256) &&
    text.includes(mcpServer) &&
    text.includes(mcpTool) &&
    observations.length > 0 &&
    consumedObservations.length === observations.length;
  return {
    ok,
    reason: ok
      ? null
      : "final agent message did not contain the observed exec, patch, and MCP values",
    message_count: messages.length,
    text_sha256: sha256Text(text),
    structured_observation_count: observations.length,
    structured_observations_consumed: consumedObservations.length,
  };
}

function validateTerminal(events, exitCode) {
  const turnCompleted = events.some((event) => event?.type === "turn.completed");
  return {
    ok: exitCode === 0 && turnCompleted,
    turn_completed: turnCompleted,
    child_exit_code: exitCode,
  };
}

function worktreeStatus(worktree, ignoredPrefixes) {
  const result = spawnSync(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    fail(`git status failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git status exited ${result.status}: ${(result.stderr || "").toString("utf8").trim()}`);
  }
  const records = (result.stdout || Buffer.alloc(0))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((record) => {
      const payload = record.slice(3);
      return !ignoredPrefixes.some((prefix) => payload.startsWith(prefix));
    })
    .sort();
  return records;
}

function bindSamples({ runtimeHome, port, threadId, startedAtMs }) {
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

function findPatchCalls(historyEntries, rawPatch) {
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
        return false;
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

function validateBoundHistory(sampleBinding, addPatch, updatePatch, mcpCheck) {
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
  const addCalls = findPatchCalls(history.entries, addPatch);
  const updateCalls = findPatchCalls(history.entries, updatePatch);
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
  const firstRequest = requestEntries[0] || null;
  const observationRequest = requestEntries.find((entry) =>
    observations.every((observation) => jsonContainsScalar(entry.value, observation.value)),
  );
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relativeOrAbsolute(worktree, target) {
  const relative = path.relative(worktree, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function cleanupPaths(paths) {
  const result = {};
  for (const [name, target] of Object.entries(paths)) {
    try {
      if (target) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      result[name] = true;
    } catch (error) {
      result[name] = false;
      result[`${name}_error`] = error.message;
    }
  }
  return result;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      process.stderr.write(`error: ${error}\n`);
    }
    printUsage(process.stderr);
    return 2;
  }

  const options = parsed.options;
  assertAbsolute(options.binary, "--binary");
  assertAbsolute(options.testedWorktree, "--tested-worktree");
  assertAbsolute(options.evidenceDir, "--evidence-dir");
  assertFile(options.binary, "candidate binary");
  if (!fs.statSync(options.testedWorktree).isDirectory()) {
    fail(`--tested-worktree is not a directory: ${options.testedWorktree}`);
  }
  if (!/^[0-9a-f]{40}$/.test(options.candidateSha)) {
    fail("--candidate-sha must be a full 40-hex SHA");
  }
  if (!/^[0-9a-f]{64}$/i.test(options.binarySha256)) {
    fail("--binary-sha256 must be a full 64-hex SHA-256");
  }
  if (!MODELS.has(options.model)) {
    fail(`--model must be one of ${[...MODELS].join(", ")}`);
  }

  const binarySha256 = sha256File(options.binary);
  if (binarySha256.toLowerCase() !== options.binarySha256.toLowerCase()) {
    fail(`candidate binary SHA-256 mismatch: expected ${options.binarySha256}, got ${binarySha256}`);
  }
  const worktreeHead = runCapture("git", ["-C", options.testedWorktree, "rev-parse", "HEAD"]).toLowerCase();
  if (worktreeHead !== options.candidateSha) {
    fail(`tested worktree HEAD ${worktreeHead} does not match --candidate-sha ${options.candidateSha}`);
  }

  const endpoint = parseEndpoint(options.endpoint);
  const sourceHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(process.env.HOME || os.homedir(), ".codex");
  const runtimeHome = process.env.RCC_HOME
    ? path.resolve(process.env.RCC_HOME)
    : path.join(process.env.HOME || os.homedir(), ".rcc");
  const profile = loadProfileTruth(sourceHome);
  if (endpoint.endpoint === profile.baseUrl.replace(/\/+$/, "")) {
    fail("candidate endpoint is the profile default; pass a distinct isolated endpoint");
  }

  const codexBin = resolveExecutable(options.codexBin);
  const codexCli = inspectCodexCli(codexBin);
  const overrideValue = `model_providers.${profile.providerId}.base_url=${JSON.stringify(endpoint.endpoint)}`;

  fs.mkdirSync(options.evidenceDir, { recursive: true });
  const runId = `${options.model.replace(/[^A-Za-z0-9.-]/g, "_")}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "-")
    .replace("Z", "")}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const evidencePrefix = path.join(options.evidenceDir, `gcm-consumer-${runId}`);
  const rawJsonlPath = `${evidencePrefix}.events.jsonl`;
  const stderrPath = `${evidencePrefix}.stderr.log`;
  const lastMessagePath = `${evidencePrefix}.last-message.txt`;
  const summaryPath = `${evidencePrefix}.summary.json`;
  const sampleBindingPath = `${evidencePrefix}.sample-binding.json`;
  const markerEvidencePath = `${evidencePrefix}.marker.txt`;

  const markerRoot = path.join(options.testedWorktree, ".req02-gcm-consumer");
  const markerDir = path.join(markerRoot, runId);
  const markerFile = path.join(markerDir, "marker.txt");
  const markerRelative = path.relative(options.testedWorktree, markerFile);
  const markerInitial = "REQ02_GCM_PATCH_INITIAL";
  const markerUpdated = "REQ02_GCM_PATCH_UPDATED";
  const markerUpdatedBytes = Buffer.from(`${markerUpdated}\n`, "utf8");
  const markerSha256 = sha256Buffer(markerUpdatedBytes);
  const sentinel = `REQ02_GCM_EXEC_SENTINEL_${runId}`;
  const addPatch = `*** Begin Patch\n*** Add File: ${markerRelative}\n+${markerInitial}\n*** End Patch`;
  const updatePatch = `*** Begin Patch\n*** Update File: ${markerRelative}\n@@\n-${markerInitial}\n+${markerUpdated}\n*** End Patch`;

  fs.mkdirSync(markerDir, { recursive: true });
  const ignoredStatusPrefixes = [path.dirname(markerRelative) + path.sep];
  const evidenceRelative = relativeOrAbsolute(options.testedWorktree, options.evidenceDir);
  if (evidenceRelative) {
    ignoredStatusPrefixes.push(evidenceRelative.replace(/\/?$/, path.sep));
  }
  const statusBefore = worktreeStatus(options.testedWorktree, ignoredStatusPrefixes);
  const isolatedHome = createIsolatedHome(sourceHome);
  const startedAtMs = Date.now();
  const prompt = buildPrompt({
    endpoint: endpoint.endpoint,
    candidateSha: options.candidateSha,
    model: options.model,
    testedWorktree: options.testedWorktree,
    markerFile,
    markerInitial,
    markerUpdated,
    markerSha256,
    sentinel,
    addPatch,
    updatePatch,
    mcpServer: options.mcpServer,
    mcpTool: options.mcpTool,
    mcpArguments: options.mcpArguments,
    mcpObservationPointers: options.mcpObservationPointers,
  });

  const childEnv = { ...process.env, CODEX_HOME: isolatedHome.home };
  for (const name of [
    "CODEX_APP_TOOLS_PIPE_PATH",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  ]) {
    delete childEnv[name];
  }

  const childArgs = [
    "exec",
    "--profile",
    PROFILE,
    "--ephemeral",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    options.testedWorktree,
    "-c",
    overrideValue,
    "-m",
    options.model,
    "--output-last-message",
    lastMessagePath,
    "-",
  ];
  const child = spawnSync(codexBin, childArgs, {
    cwd: options.testedWorktree,
    env: childEnv,
    input: prompt,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
  });

  const stdout = child.stdout || Buffer.alloc(0);
  const stderr = child.stderr || Buffer.alloc(0);
  fs.writeFileSync(rawJsonlPath, stdout);
  fs.writeFileSync(stderrPath, stderr);

  const parsedEvents = parseJsonl(stdout);
  const entries = itemEvents(parsedEvents.events);
  const threadId = parsedEvents.events.find((event) => event?.type === "thread.started")?.thread_id || null;
  const childExitCode = child.status;
  const execCheck = validateExec(entries, options.testedWorktree, sentinel);
  const patchCheck = validatePatch(
    entries,
    markerRelative,
    markerInitial,
    markerUpdated,
    markerSha256,
    markerUpdatedBytes.length,
  );
  const mcpCheck = validateMcp(
    entries,
    options.mcpServer,
    options.mcpTool,
    options.mcpArguments,
    options.mcpObservationPointers,
  );
  const consumptionCheck = validateModelConsumption(
    parsedEvents.events,
    sentinel,
    markerUpdated,
    markerSha256,
    mcpCheck,
    options.mcpServer,
    options.mcpTool,
  );
  const terminalCheck = validateTerminal(parsedEvents.events, childExitCode);

  let markerBytes = null;
  let markerActualSha256 = null;
  let markerActualText = null;
  let markerMatches = false;
  if (fs.existsSync(markerFile)) {
    markerBytes = fs.readFileSync(markerFile);
    markerActualSha256 = sha256Buffer(markerBytes);
    markerActualText = markerBytes.toString("utf8");
    markerMatches = markerBytes.equals(markerUpdatedBytes);
    fs.writeFileSync(markerEvidencePath, markerBytes);
  }

  const statusAfter = worktreeStatus(options.testedWorktree, ignoredStatusPrefixes);
  const statusBeforeSet = new Set(statusBefore);
  const unexpectedWorktreeChanges = statusAfter.filter((record) => !statusBeforeSet.has(record));
  const sampleBinding = bindSamples({
    runtimeHome,
    port: endpoint.port,
    threadId,
    startedAtMs,
  });
  const boundHistoryCheck = validateBoundHistory(
    sampleBinding,
    addPatch,
    updatePatch,
    mcpCheck,
  );

  const stageToolExecution = execCheck.ok && patchCheck.ok && mcpCheck.ok;
  const stageResultReturn = execCheck.ok && patchCheck.ok && mcpCheck.ok;
  const stageModelConsumption = consumptionCheck.ok;
  const stageTerminal = terminalCheck.ok && parsedEvents.parseErrors.length === 0;
  const stageBoundHistory = boundHistoryCheck.ok;
  const stageSampleBinding = sampleBinding.status === "bound" && stageBoundHistory;
  const stageMarker = markerMatches;
  const stageNoSideEffects = unexpectedWorktreeChanges.length === 0;
  const overall =
    stageToolExecution &&
    stageResultReturn &&
    stageModelConsumption &&
    stageTerminal &&
    stageSampleBinding &&
    stageMarker &&
    stageNoSideEffects;

  const summary = {
    schema: SCHEMA,
    run_id: runId,
    status: overall ? "PASS" : "FAIL",
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date().toISOString(),
    input: {
      endpoint: endpoint.endpoint,
      candidate_sha: options.candidateSha,
      binary_path: options.binary,
      binary_sha256: binarySha256,
      model: options.model,
      tested_worktree: options.testedWorktree,
      evidence_dir: options.evidenceDir,
      profile: PROFILE,
      profile_config: profile.profileConfig,
      base_config: profile.baseConfig,
      provider_id: profile.providerId,
      provider_id_source: profile.providerSource,
      profile_base_url: profile.baseUrl,
      profile_base_url_source: profile.baseUrlSource,
      codex_cli: codexCli,
      mcp_server: options.mcpServer,
      mcp_tool: options.mcpTool,
      mcp_arguments: options.mcpArguments,
      mcp_observation_pointers: options.mcpObservationPointers,
    },
    child_command: {
      argv: [codexBin, ...childArgs],
      cwd: options.testedWorktree,
      config_override: overrideValue,
      isolated_codex_home: isolatedHome.home,
      ephemeral: true,
      sandbox: "workspace-write",
    },
    artifacts: {
      raw_jsonl: rawJsonlPath,
      stderr: stderrPath,
      last_message: lastMessagePath,
      summary: summaryPath,
      sample_binding: sampleBindingPath,
      marker_evidence: fs.existsSync(markerEvidencePath) ? markerEvidencePath : null,
    },
    child: {
      exit_code: childExitCode,
      signal: child.signal || null,
      timed_out: Boolean(child.error && child.error.code === "ETIMEDOUT"),
      error: child.error ? child.error.message : null,
      thread_id: threadId,
    },
    event_contract: {
      json_parse_errors: parsedEvents.parseErrors,
      event_count: parsedEvents.events.length,
      event_types: [...new Set(parsedEvents.events.map((event) => event?.type).filter(Boolean))],
      item_types: [
        ...new Set(
          parsedEvents.events
            .map((event) => event?.item?.type)
            .filter(Boolean),
        ),
      ],
    },
    checks: {
      tool_execution: stageToolExecution,
      result_return: stageResultReturn,
      model_consumption: stageModelConsumption,
      terminal: stageTerminal,
      sample_binding: stageSampleBinding,
      bound_history: stageBoundHistory,
      marker_bytes_and_hash: stageMarker,
      no_unexpected_worktree_changes: stageNoSideEffects,
    },
    exec: execCheck,
    patch: {
      ...patchCheck,
      marker_file: markerFile,
      marker_relative: markerRelative,
      expected_text: `${markerUpdated}\n`,
      actual_text: markerActualText,
      expected_sha256: markerSha256,
      actual_sha256: markerActualSha256,
      actual_bytes: markerBytes ? markerBytes.length : null,
    },
    mcp: mcpCheck,
    model_consumption: consumptionCheck,
    worktree: {
      status_before: statusBefore,
      status_after: statusAfter,
      unexpected_changes: unexpectedWorktreeChanges,
    },
    sample_binding: {
      ...sampleBinding,
      history: boundHistoryCheck,
    },
    retained_on_failure: overall ? null : {
      isolated_codex_home: isolatedHome.home,
      marker_dir: markerDir,
    },
  };

  writeJson(sampleBindingPath, summary.sample_binding);

  if (overall) {
    summary.cleanup = cleanupPaths({
      child_home_removed: isolatedHome.root,
      marker_dir_removed: markerDir,
    });
    if (!summary.cleanup.child_home_removed || !summary.cleanup.marker_dir_removed) {
      summary.status = "FAIL";
      summary.checks.cleanup = false;
    }
    try {
      fs.rmdirSync(markerRoot);
    } catch {
      // The parent marker root is shared by prior runs; leave it in place.
    }
  } else {
    summary.cleanup = {
      child_home_removed: false,
      marker_dir_removed: false,
      retained_for_recovery: true,
    };
  }

  writeJson(summaryPath, summary);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: summary.status,
        summary: summaryPath,
        raw_jsonl: rawJsonlPath,
        request_ids: sampleBinding.matches.map((match) => match.request_id),
        marker_sha256: markerActualSha256,
        retained: summary.retained_on_failure,
      },
      null,
      2,
    )}\n`,
  );

  return summary.status === "PASS" ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
