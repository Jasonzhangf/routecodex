#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  MODELS,
  PROFILE,
  SCHEMA,
  parseArgs,
  printUsage,
} from "./gcm-consumer-cli.mjs";
import {
  itemEvents,
  parseJsonl,
  validateExec,
  validateMcp,
  validateModelConsumption,
  validatePatch,
  validateTerminal,
} from "./gcm-consumer-events.mjs";
import {
  createIsolatedHome,
  inspectCodexCli,
  loadProfileTruth,
  resolveExecutable,
} from "./gcm-consumer-runtime-setup.mjs";
import {
  bindSamples,
  validateBoundHistory,
} from "./gcm-consumer-history.mjs";
import {
  assertAbsolute,
  assertFile,
  fail,
  runCapture,
  sha256Buffer,
  sha256File,
} from "./gcm-consumer-utils.mjs";
import {
  buildChildArgs,
  buildPrompt,
} from "./gcm-consumer-runner.mjs";

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
  const profile = loadProfileTruth(sourceHome, PROFILE);
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
  const isolatedHome = createIsolatedHome(sourceHome, PROFILE);
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

  const childArgs = buildChildArgs({
    profile: PROFILE,
    testedWorktree: options.testedWorktree,
    overrideValue,
    model: options.model,
    lastMessagePath,
  });
  const child = spawnSync(codexBin, childArgs, {
    cwd: options.testedWorktree,
    env: childEnv,
    input: prompt,
    encoding: null,
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
    markerFile,
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
