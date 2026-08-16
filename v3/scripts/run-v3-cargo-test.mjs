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
import { fileURLToPath } from 'node:url';

export const MAX_DEBUG_BYTES = 2147483648;
const CLEANUP_FAILURE_EXIT = 86;
const STALE_LOCK_GRACE_MS = 60_000;
const UNVERIFIABLE_LIVE_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
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

function cargoEnv() {
  return {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
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

function activeV3BuilderCommands() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`unable to inspect active V3 builders: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  const ownPid = String(process.pid);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(`${ownPid} `))
    .filter((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/u);
      if (!match) return false;
      const pid = Number(match[1]);
      const command = match[2];
      if (!/(?:^|\s)(?:\S*\/)?(?:cargo|rustc)(?:\s|$)/u.test(command)) return false;
      if (
        command.includes('v3/Cargo.toml')
        || command.includes(`${sep}v3${sep}target${sep}`)
        || /(?:^|\s)-p\s+routecodex-v3[-\w]*/u.test(command)
        || /\broutecodex[-_]v3[-_]/u.test(command)
      ) {
        return true;
      }
      if (!isBareWorkspaceCargoBuildOrTest(command)) return false;
      const cwd = Number.isInteger(pid) ? currentProcessCwd(pid) : null;
      return cwd === null || resolve(cwd) === v3Root;
    });
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

export function enforceV3DebugBudget({
  debugDir: ownedDebugDir = debugDir,
  maxBytes = MAX_DEBUG_BYTES,
  activeBuilders = activeV3BuilderCommands,
  cleanTestProfile = cleanV3TestProfile,
} = {}) {
  try {
    return verifyV3DebugBudget({ debugDir: ownedDebugDir, maxBytes });
  } catch (budgetError) {
    const builders = activeBuilders();
    if (builders.length > 0) {
      throw new Error(`${budgetError.message}; refusing cache eviction while V3 builders are active:\n${builders.join('\n')}`);
    }
    cleanTestProfile();
    return verifyV3DebugBudget({ debugDir: ownedDebugDir, maxBytes });
  }
}

function acquireLock() {
  mkdirSync(targetDir, { recursive: true });
  try {
    createOwnedLock();
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      if (reclaimStaleLock()) {
        createOwnedLock();
        return;
      }
      throw new Error(`another canonical V3 Cargo test owns ${lockDir}`);
    }
    throw error;
  }
}

function createOwnedLock() {
  mkdirSync(lockDir);
  try {
    writeLockOwner();
  } catch (error) {
    removePath(lockDir);
    throw error;
  }
}

function releaseLock() {
  removePath(lockDir);
}

function writeLockOwner() {
  const identity = ownProcessIdentity();
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: process.pid,
      cwd: v3Root,
      startedAt: new Date().toISOString(),
      processStartedAt: identity.processStartedAt,
    }),
  );
}

function reclaimStaleLock() {
  let lockStat;
  try {
    lockStat = statSync(lockDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
  if (!existsSync(lockOwnerPath)) {
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_GRACE_MS) return false;
    removePath(lockDir);
    return true;
  }
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockOwnerPath, 'utf8'));
  } catch {
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_GRACE_MS) return false;
    removePath(lockDir);
    return true;
  }
  const pid = Number(owner?.pid);
  const liveIdentity = Number.isInteger(pid) && pid > 0 ? currentProcessIdentity(pid) : null;
  if (liveIdentity && lockOwnerMatchesProcess(owner, liveIdentity)) return false;
  if (
    liveIdentity
    && liveIdentity.processStartedAt === null
    && Date.now() - lockStat.mtimeMs <= UNVERIFIABLE_LIVE_LOCK_MAX_AGE_MS
  ) {
    return false;
  }
  removePath(lockDir);
  return true;
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

function executeCargo(cargoArgs, executables) {
  return new Promise((resolveExit, reject) => {
    const child = spawn('cargo', cargoArgs, {
      cwd: v3Root,
      env: cargoEnv(),
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let buffered = '';
    let parseError = null;
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
      buffered += chunk;
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n');
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleLine(line);
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      handleLine(buffered);
      if (parseError) {
        reject(parseError);
        return;
      }
      if (signal) process.stderr.write(`[v3-cargo-test] cargo terminated by ${signal}\n`);
      resolveExit(code ?? 1);
    });
  });
}

export async function runV3CargoTest(args) {
  let cargoArgs;
  try {
    cargoArgs = buildCargoArgs(args);
    acquireLock();
  } catch (error) {
    process.stderr.write(`[v3-cargo-test] ${error instanceof Error ? error.message : String(error)}\n`);
    return CLEANUP_FAILURE_EXIT;
  }
  const executables = new Set();
  let cargoExit = 1;
  let terminalError = null;
  try {
    cargoExit = await executeCargo(cargoArgs, executables);
  } catch (error) {
    terminalError = error;
  } finally {
    try {
      await releaseOwnedTestArtifacts({ executables });
      const bytes = enforceV3DebugBudget();
      process.stdout.write(`[v3-cargo-test] debug allocation after cleanup: ${bytes} bytes\n`);
    } catch (error) {
      terminalError = terminalError ?? error;
    }
    releaseLock();
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
