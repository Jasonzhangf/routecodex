#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const MAX_DEBUG_BYTES = 2147483648;
const CLEANUP_FAILURE_EXIT = 86;
export const CARGO_TEST_TIMEOUT_MS = 40 * 60 * 1000;
export const PROCESS_GROUP_UNREAPED = 'V3_CARGO_TEST_PROCESS_GROUP_UNREAPED';
const CARGO_TEST_KILL_GRACE_MS = 5_000;
const STALE_LOCK_GRACE_MS = 60_000;
const UNVERIFIABLE_LIVE_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_V3_TEST_THREAD_STACK_BYTES = '8388608';
const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(v3Root, 'Cargo.toml');
const suppliedCargoTargetDir = process.env.CARGO_TARGET_DIR;
const suppliedTargetRoot = suppliedCargoTargetDir
  ? (isAbsolute(suppliedCargoTargetDir)
    ? resolve(suppliedCargoTargetDir)
    : resolve(v3Root, suppliedCargoTargetDir))
  : null;
const suppliedTargetRelative = suppliedTargetRoot ? relative(v3Root, suppliedTargetRoot) : null;
if (
  suppliedTargetRelative
  && (suppliedTargetRelative === '..'
    || suppliedTargetRelative.startsWith(`..${sep}`)
    || isAbsolute(suppliedTargetRelative))
) {
  throw new Error(`external CARGO_TARGET_DIR is forbidden: ${suppliedTargetRoot}`);
}
const targetDir = suppliedTargetRoot ?? join(v3Root, 'target');
const debugDir = join(targetDir, 'debug');
const debugDepsDir = join(debugDir, 'deps');
const lockDir = join(targetDir, '.routecodex-v3-test.lock');
const lockOwnerPath = join(lockDir, 'owner.json');
const lockExecutionPath = join(lockDir, 'execution-in-progress');

function cargoEnv() {
  return {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    RUST_MIN_STACK: process.env.RUST_MIN_STACK ?? DEFAULT_V3_TEST_THREAD_STACK_BYTES,
  };
}

function removePath(path) {
  rmSync(path, { recursive: true, force: true });
}

function parseCargoMessage(line, executables) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }
  if (message.reason === 'compiler-message') {
    const rendered = message.message?.rendered;
    if (rendered) process.stderr.write(rendered);
    return;
  }
  if (message.reason === 'compiler-artifact' && message.profile?.test === true && typeof message.executable === 'string') {
    const executable = resolve(message.executable);
    const expectedPrefix = `${debugDepsDir}${sep}`;
    if (!executable.startsWith(expectedPrefix)) {
      throw new Error(`test executable escaped V3 debug deps: ${executable}`);
    }
    executables.add(executable);
  }
}

function buildCargoArgs(args) {
  const cargoArgs = [...args];
  const toolchain = cargoArgs[0]?.startsWith('+') ? cargoArgs.shift() : null;
  const separator = cargoArgs.indexOf('--');
  const cargoOptions = separator === -1 ? cargoArgs : cargoArgs.slice(0, separator);
  const testOptions = separator === -1 ? [] : cargoArgs.slice(separator);
  if (cargoOptions.includes('--message-format') || cargoOptions.some((arg) => arg.startsWith('--message-format='))) {
    throw new Error('message format is owned by v3/scripts/run-cargo-test.mjs');
  }
  const ownedCargoOptions = [];
  for (let index = 0; index < cargoOptions.length; index += 1) {
    const argument = cargoOptions[index];
    if (argument !== '--manifest-path') {
      ownedCargoOptions.push(argument);
      continue;
    }
    const suppliedManifest = cargoOptions[index + 1];
    if (!suppliedManifest) throw new Error('--manifest-path requires a value');
    if (resolve(v3Root, suppliedManifest) !== manifestPath) {
      throw new Error(`V3 test wrapper cannot execute another manifest: ${suppliedManifest}`);
    }
    index += 1;
  }
  const normalized = [
    ...(toolchain ? [toolchain] : []),
    'test',
    '--manifest-path',
    manifestPath,
    ...ownedCargoOptions,
  ];
  normalized.push('--message-format=json-render-diagnostics', ...testOptions);
  return normalized;
}

function allocatedBytes(path) {
  try {
    statSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`unable to measure ${path}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  const kibibytes = Number.parseInt(result.stdout.trim().split(/\s+/u)[0] ?? '', 10);
  if (!Number.isFinite(kibibytes)) throw new Error(`invalid du output for ${path}: ${result.stdout}`);
  return kibibytes * 1024;
}

export async function releaseOwnedTestArtifacts({
  executables,
  debugDepsDir: ownedDebugDepsDir = debugDepsDir,
}) {
  let entries;
  try {
    entries = readdirSync(ownedDebugDepsDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  const executablePrefixes = new Set([...executables].map((path) => basename(path)));
  for (const executable of executables) {
    removePath(executable);
    removePath(`${executable}.d`);
    removePath(`${executable}.dSYM`);
    removePath(`${executable}.pdb`);
  }
  for (const entry of entries) {
    if (!entry.endsWith('.rcgu.o')) continue;
    const path = join(ownedDebugDepsDir, entry);
    const belongsToExecutable = [...executablePrefixes].some((prefix) => entry.startsWith(`${prefix}.`));
    if (belongsToExecutable) removePath(path);
  }
}

export function verifyV3DebugBudget({
  debugDir: ownedDebugDir = debugDir,
  maxBytes = MAX_DEBUG_BYTES,
} = {}) {
  const bytes = allocatedBytes(ownedDebugDir);
  if (bytes > maxBytes) {
    throw new Error(`V3 debug allocation ${bytes} bytes exceeds ${maxBytes} byte budget after test cleanup`);
  }
  return bytes;
}

function streamProcessLines(command, args, handleLine) {
  return new Promise((resolveCompletion, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (error) {
      reject(error);
      return;
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const finish = (error, completion) => {
      if (settled) return;
      settled = true;
      lines.close();
      if (error) {
        try { child.kill('SIGKILL'); } catch {}
        reject(error);
        return;
      }
      resolveCompletion(completion);
    };
    lines.on('line', (line) => {
      if (settled) return;
      try {
        handleLine(line.trim());
      } catch (error) {
        finish(error);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => finish(null, { code, signal }));
  });
}

async function activeV3BuilderCommands() {
  const ownPid = process.pid;
  const candidates = new Set();
  try {
    const inventory = await streamProcessLines('ps', ['-axo', 'pid=,ucomm='], (line) => {
      if (!line) return;
      const processInfo = parseV3BuilderProcessLine(line);
      if (processInfo && processInfo.pid !== ownPid) candidates.add(processInfo.pid);
    });
    if (inventory.signal) throw new Error(`ps terminated by ${inventory.signal}`);
    if (inventory.code !== 0) throw new Error(`ps exit ${inventory.code}`);
  } catch (error) {
    throw new Error(`unable to inspect active V3 builders: ${error instanceof Error ? error.message : String(error)}`);
  }
  const builders = [];
  for (const pid of candidates) {
    let lineCount = 0;
    try {
      const selected = await streamProcessLines(
        'ps',
        ['-ww', '-p', String(pid), '-o', 'pid=,ucomm=,command='],
        (line) => {
          if (!line) return;
          lineCount += 1;
          if (builderCommandUsesOwnedV3Domain(line)) builders.push(line);
        },
      );
      if (selected.signal) throw new Error(`ps terminated by ${selected.signal}`);
      if (selected.code !== 0 && !(lineCount === 0 && !processExists(pid))) {
        throw new Error(`ps exit ${selected.code}`);
      }
    } catch (error) {
      throw new Error(`unable to inspect active V3 builders: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return builders;
}

export function parseV3BuilderProcessLine(line) {
  const match = line.match(/^(\d+)\s+(\S+)(?:\s+(.+))?$/u);
  if (!match) return null;
  const pid = Number(match[1]);
  const executable = basename(match[2]);
  if (executable !== 'cargo' && executable !== 'rustc') return null;
  const command = match[3] ? `${match[2]} ${match[3]}` : match[2];
  return { pid, executable, command };
}

export function builderCommandUsesOwnedV3Domain(line, cwdReader = currentProcessCwd) {
  const process = parseV3BuilderProcessLine(line);
  if (!process) return false;
  const { pid, command } = process;
  if (command.includes(manifestPath) || command.includes(targetDir)) return true;
  const looksLikeV3Builder = command.includes('v3/Cargo.toml')
    || command.includes(`${sep}v3${sep}target${sep}`)
    || /(?:^|\s)-p\s+routecodex-v3[-\w]*/u.test(command)
    || /\broutecodex[-_]v3[-_]/u.test(command)
    || isBareWorkspaceCargoBuildOrTest(command);
  if (!looksLikeV3Builder) return false;
  const cwd = Number.isInteger(pid) ? cwdReader(pid) : null;
  if (cwd === null) return true;
  const relativeCwd = relative(v3Root, resolve(cwd));
  return relativeCwd === ''
    || (!relativeCwd.startsWith(`..${sep}`) && relativeCwd !== '..' && !isAbsolute(relativeCwd));
}

function isBareWorkspaceCargoBuildOrTest(command) {
  return /(?:^|\s)(?:\S*\/)?cargo\s+(?:\+\S+\s+)?(?:build|test)\b(?=[\s\S]*(?:^|\s)--workspace(?:\s|$))/u.test(command);
}

function currentProcessCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) return null;
    const cwdLine = result.stdout.split('\n').find((line) => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : null;
  }
}

function cleanV3TestProfile() {
  const result = spawnSync('cargo', [
    'clean',
    '--manifest-path',
    manifestPath,
    '--profile',
    'test',
  ], {
    cwd: v3Root,
    encoding: 'utf8',
    env: cargoEnv(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`V3 test-profile cleanup failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
}

export async function enforceV3DebugBudget({
  debugDir: ownedDebugDir = debugDir,
  maxBytes = MAX_DEBUG_BYTES,
  activeBuilders = activeV3BuilderCommands,
  cleanTestProfile = cleanV3TestProfile,
} = {}) {
  if ((await activeBuilders()).length > 0) {
    process.stderr.write('[v3-cargo-test] refusing cache eviction while V3 builders are active; cache maintenance deferred\n');
    return null;
  }
  try {
    return verifyV3DebugBudget({ debugDir: ownedDebugDir, maxBytes });
  } catch (budgetError) {
    if ((await activeBuilders()).length > 0) {
      process.stderr.write('[v3-cargo-test] refusing cache eviction while V3 builders are active; cache maintenance deferred\n');
      return null;
    }
    cleanTestProfile();
    return verifyV3DebugBudget({ debugDir: ownedDebugDir, maxBytes });
  }
}

function acquireLock(probeCommand) {
  mkdirSync(targetDir, { recursive: true });
  try {
    createOwnedLock();
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const reclaim = reclaimStaleLock(probeCommand);
      if (reclaim.reclaimed) {
        createOwnedLock();
        return;
      }
      throw new Error(
        `another canonical V3 Cargo test owns ${lockDir}${reclaim.reason ? `: ${reclaim.reason}` : ''}`,
      );
    }
    throw error;
  }
}

function createOwnedLock() {
  mkdirSync(lockDir);
  try {
    writeFileSync(lockExecutionPath, 'canonical V3 Cargo test execution in progress\n');
    writeLockOwner();
  } catch (error) {
    removePath(lockDir);
    throw error;
  }
}

function releaseLock() {
  removePath(lockDir);
}

function writeLockOwner(unreapedProcessGroup = null) {
  const identity = ownProcessIdentity();
  const owner = {
    pid: process.pid,
    cwd: v3Root,
    startedAt: new Date().toISOString(),
    processStartedAt: identity.processStartedAt,
  };
  if (unreapedProcessGroup) owner.unreapedProcessGroup = unreapedProcessGroup;
  writeFileSync(
    lockOwnerPath,
    JSON.stringify(owner),
  );
}

// A wrapper that exits with an unreaped process group must not let its dead PID
// authorize the next caller to reuse the target. Only a probe that confirms the
// persisted group has no live member may release this lock.
function reclaimUnreapedLock(owner, probeCommand) {
  const processGroupId = Number(owner?.unreapedProcessGroup?.processGroupId);
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    return {
      reclaimed: false,
      reason: 'unreaped process group identity is incomplete; refusing to reuse the target',
    };
  }
  let state;
  try {
    state = probeProcessGroup(processGroupId, probeCommand);
  } catch (error) {
    return {
      reclaimed: false,
      reason: `unreaped process group ${processGroupId} probe failed: ${error?.message ?? String(error)}`,
    };
  }
  if (state !== 'gone') {
    return {
      reclaimed: false,
      reason: `unreaped process group ${processGroupId} still has live members`,
    };
  }
  removePath(lockDir);
  return { reclaimed: true };
}

function reclaimStaleLock(probeCommand) {
  let lockStat;
  try {
    lockStat = statSync(lockDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { reclaimed: true };
    throw error;
  }
  let executionInProgress;
  try {
    executionInProgress = existsSync(lockExecutionPath);
  } catch (error) {
    return {
      reclaimed: false,
      reason: `lock execution marker is unreadable: ${error?.message ?? String(error)}; refusing to reuse the target`,
    };
  }
  if (!existsSync(lockOwnerPath)) {
    if (executionInProgress) {
      return {
        reclaimed: false,
        reason: 'lock execution marker has no persisted unreaped group; refusing to reuse the target',
      };
    }
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_GRACE_MS) {
      return { reclaimed: false, reason: 'lock grace has not elapsed' };
    }
    removePath(lockDir);
    return { reclaimed: true };
  }
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockOwnerPath, 'utf8'));
  } catch {
    if (executionInProgress) {
      return {
        reclaimed: false,
        reason: 'lock owner is incomplete while an execution marker is retained; refusing to reuse the target',
      };
    }
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_GRACE_MS) {
      return { reclaimed: false, reason: 'lock grace has not elapsed' };
    }
    removePath(lockDir);
    return { reclaimed: true };
  }
  if (owner?.unreapedProcessGroup) {
    return reclaimUnreapedLock(owner, probeCommand);
  }
  if (executionInProgress) {
    return {
      reclaimed: false,
      reason: 'lock execution marker has no unreaped group identity; refusing to reuse the target',
    };
  }
  const pid = Number(owner?.pid);
  const liveIdentity = Number.isInteger(pid) && pid > 0 ? currentProcessIdentity(pid) : null;
  if (liveIdentity && lockOwnerMatchesProcess(owner, liveIdentity)) {
    return { reclaimed: false, reason: 'lock owner process is still alive' };
  }
  if (
    liveIdentity
    && liveIdentity.processStartedAt === null
    && Date.now() - lockStat.mtimeMs <= UNVERIFIABLE_LIVE_LOCK_MAX_AGE_MS
  ) {
    return { reclaimed: false, reason: 'lock owner process identity is unverifiable' };
  }
  removePath(lockDir);
  return { reclaimed: true };
}

function ownProcessIdentity() {
  return {
    pid: process.pid,
    processStartedAt: new Date(
      Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000,
    ).toISOString(),
  };
}

export function currentProcessIdentity(pid) {
  if (pid === process.pid) return ownProcessIdentity();
  if (!processExists(pid)) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error) return { pid, processStartedAt: null };
  if (result.status !== 0) return { pid, processStartedAt: null };
  const rawProcessStartedAt = result.stdout.trim();
  const parsedProcessStartedAt = Date.parse(rawProcessStartedAt);
  const processStartedAt = Number.isFinite(parsedProcessStartedAt)
    ? new Date(Math.floor(parsedProcessStartedAt / 1000) * 1000).toISOString()
    : rawProcessStartedAt;
  return processStartedAt ? { pid, processStartedAt } : { pid, processStartedAt: null };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

export function lockOwnerMatchesProcess(owner, liveIdentity) {
  return Number(owner?.pid) === liveIdentity?.pid
    && typeof owner?.processStartedAt === 'string'
    && owner.processStartedAt.length > 0
    && owner.processStartedAt === liveIdentity?.processStartedAt;
}

function defaultProbeCommand(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

// `pgrep -g` exit 0 means the group still has a live member and exit 1 means it
// has none. Any other outcome is an unusable probe, never evidence of reaping.
function probeProcessGroup(pid, probeCommand) {
  const probe = probeCommand('pgrep', ['-g', String(pid)]);
  if (probe?.error) throw probe.error;
  if (probe?.status === 1) return 'gone';
  if (probe?.status === 0) return 'alive';
  throw new Error(`pgrep -g ${pid} failed with status ${probe?.status}`);
}

export function isUnreapedProcessGroupError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === PROCESS_GROUP_UNREAPED;
}

function unreapedProcessGroupError(pid, detail) {
  return Object.assign(
    new Error(`cargo test timed out and process group ${pid} was not confirmed stopped (${detail})`),
    { code: PROCESS_GROUP_UNREAPED, processGroupId: pid },
  );
}

export function executeCargo(cargoArgs, executables, {
  timeoutMs = CARGO_TEST_TIMEOUT_MS,
  killGraceMs = CARGO_TEST_KILL_GRACE_MS,
  command = 'cargo',
  probeCommand = defaultProbeCommand,
} = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, cargoArgs, {
      cwd: v3Root,
      env: cargoEnv(),
      stdio: ['inherit', 'pipe', 'inherit'],
      detached: true,
    });
    let buffered = '', parseError = null, timedOut = false, settled = false, finishing = false;
    let groupKilled = false, pendingClose = null, killTimer, timeoutTimer;
    const signalDeliveryErrors = [];
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(error);
    };
    const settleResolve = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolveExit(code);
    };
    const handleLine = (line) => {
      if (!line || parseError) return;
      try {
        parseCargoMessage(line, executables);
      } catch (error) {
        parseError = error;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffered += chunk;
      while (buffered.includes('\n')) { const newline = buffered.indexOf('\n'); handleLine(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1); }
    });
    child.on('error', settleReject);
    const finish = (code, signal) => {
      if (settled || finishing) return;
      // A timeout must stay pending until the kill-grace group SIGKILL has
      // actually removed the process group. `exit` fires as soon as cargo
      // itself dies from SIGTERM, but the group may still own descendants
      // that ignore SIGTERM and hold the inherited stdout pipe.
      if (timedOut && !groupKilled) {
        pendingClose = { code, signal };
        return;
      }
      finishing = true;
      handleLine(buffered);
      if (parseError) return settleReject(parseError);
      if (signal) process.stderr.write(`[v3-cargo-test] cargo terminated by ${signal}\n`);
      if (timedOut) {
        const signalDetail = signalDeliveryErrors.length > 0 ? ` (${signalDeliveryErrors.join('; ')})` : '';
        return settleReject(new Error(`cargo test timed out after ${timeoutMs}ms and was terminated${signalDetail}`));
      }
      settleResolve(code ?? 1);
    };
    // Normal completion settles only after stdout closes; a timeout is the
    // bounded escape hatch for a descendant that keeps the pipe open.
    child.on('close', finish);
    child.on('exit', (code, signal) => {
      if (timedOut && groupKilled) finish(code, signal);
    });
    const destroyStdoutSoon = () => {
      if (!child.stdout.destroyed) child.stdout.destroy();
    };
    // A group that could not be confirmed stopped must not keep this Node
    // process alive through the ChildProcess handle. The lock owner already
    // records the process group for a later run to reclaim.
    const abandonUnreapedGroup = () => {
      destroyStdoutSoon();
      child.unref();
    };
    // Bounded by killGraceMs: a probe that throws and a probe that keeps
    // reporting a live member both produce a controlled `stopped: false`
    // result instead of an unhandled rejection or a lost timeout signal.
    const waitForProcessGroupGone = async (pid) => {
      const deadline = Date.now() + killGraceMs;
      for (;;) {
        let state;
        try {
          state = probeProcessGroup(pid, probeCommand);
        } catch (error) {
          return { stopped: false, detail: `process-group probe failed: ${error?.message ?? String(error)}` };
        }
        if (state === 'gone') return { stopped: true };
        if (Date.now() >= deadline) {
          return { stopped: false, detail: `process group still has live members after the ${killGraceMs}ms kill grace` };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // A signal-delivery error other than ESRCH does not prove the group is
    // gone. Probe once: a confirmed-gone group is equivalent to the race ESRCH
    // covers, while a live member or an unusable probe must fail closed as the
    // typed unreaped-group outcome so the caller retains the lock and artifacts.
    // The original signal error stays in the diagnostic detail.
    const settleOnSignalError = (pid, error, stage) => {
      if (settled) return;
      let state = null;
      let probeDetail = null;
      try {
        state = probeProcessGroup(pid, probeCommand);
      } catch (probeError) {
        probeDetail = probeError?.message ?? String(probeError);
      }
      if (state === 'gone') {
        const detail = `${stage} signal delivery failed with ${error?.code ?? String(error)}; process group confirmed gone`;
        signalDeliveryErrors.push(detail);
        process.stderr.write(`[v3-cargo-test] ${detail}\n`);
        return;
      }
      const detail = state === 'alive'
        ? `${stage} signal delivery failed with ${error?.code ?? String(error)}; process group still has live members`
        : `${stage} signal delivery failed with ${error?.code ?? String(error)}; unconfirmed absence (${probeDetail})`;
      settleReject(unreapedProcessGroupError(pid, detail));
      abandonUnreapedGroup();
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[v3-cargo-test] cargo timeout ${timeoutMs}ms; sending SIGTERM to process group ${child.pid}\n`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') settleOnSignalError(child.pid, error, 'SIGTERM'); }
      killTimer = setTimeout(async () => {
        try {
          process.stderr.write(`[v3-cargo-test] cargo timeout grace expired; sending SIGKILL to process group ${child.pid}\n`);
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') settleOnSignalError(child.pid, error, 'SIGKILL'); }
          // Wait until the SIGKILLed group has no live member before settling,
          // so the caller's lock and artifact cleanup follow the group cleanup.
          const reaped = await waitForProcessGroupGone(child.pid);
          if (!reaped.stopped) {
            settleReject(unreapedProcessGroupError(child.pid, reaped.detail));
            abandonUnreapedGroup();
            return;
          }
          groupKilled = true;
          // Closing the read end makes finish settle even if an orphan somehow
          // still holds the pipe; pendingClose covers a close that already fired.
          destroyStdoutSoon();
          if (pendingClose) finish(pendingClose.code, pendingClose.signal);
        } catch (error) {
          // No async rejection may escape this timer callback: it would bypass
          // the caller's controlled cleanup decision.
          settleReject(unreapedProcessGroupError(child.pid, `cleanup callback failed: ${error?.message ?? String(error)}`));
          abandonUnreapedGroup();
        }
      }, killGraceMs);
    }, timeoutMs);
  });
}

export async function runV3CargoTest(args, { execute = executeCargo, probeCommand = defaultProbeCommand } = {}) {
  let cargoArgs;
  try {
    cargoArgs = buildCargoArgs(args);
    acquireLock(probeCommand);
  } catch (error) {
    process.stderr.write(`[v3-cargo-test] ${error instanceof Error ? error.message : String(error)}\n`);
    return CLEANUP_FAILURE_EXIT;
  }
  const executables = new Set();
  let cargoExit = 1;
  let terminalError = null;
  try {
    cargoExit = await execute(cargoArgs, executables);
  } catch (error) {
    terminalError = error;
  } finally {
    if (isUnreapedProcessGroupError(terminalError)) {
      // The group may still own this target directory, so artifacts and the
      // lock stay in place until a later run reclaims them. Persist the
      // unreaped group identity as the lock owner so a dead wrapper PID can
      // never by itself authorize reuse of the target.
      let persistError = null;
      try {
        writeLockOwner({
          processGroupId: terminalError.processGroupId,
          detail: terminalError.message,
        });
      } catch (error) {
        persistError = error;
      }
      if (persistError) {
        // The group was never confirmed reaped, so even an unpersisted owner
        // must keep the lock and artifacts fail-closed.
        terminalError = persistError;
        process.stderr.write('[v3-cargo-test] unable to persist unreaped process group identity; retaining test lock and artifacts\n');
      } else {
        process.stderr.write('[v3-cargo-test] process group not confirmed stopped; retaining test lock and artifacts\n');
      }
    } else {
      try {
        await releaseOwnedTestArtifacts({ executables });
        const bytes = await enforceV3DebugBudget();
        if (bytes !== null) {
          process.stdout.write(`[v3-cargo-test] debug allocation after cleanup: ${bytes} bytes\n`);
        }
      } catch (error) {
        terminalError = terminalError ?? error;
      }
      releaseLock();
    }
  }
  if (terminalError) {
    process.stderr.write(`[v3-cargo-test] ${terminalError instanceof Error ? terminalError.message : String(terminalError)}\n`);
    return CLEANUP_FAILURE_EXIT;
  }
  return cargoExit;
}

async function main() {
  const exitCode = await runV3CargoTest(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
