#!/usr/bin/env node
/**
 * Exec capability checker
 * - Detects presence of common shells (bash/zsh/sh)
 * - Tests direct exec (argv, no shell semantics)
 * - Tests bash -lc semantics: pipe, connectors, background, redirection, glob, subshell, heredoc
 * - Produces a concise JSON summary
 */

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const wait = (ms) => new Promise(res => setTimeout(res, ms));

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    cp.stdout && cp.stdout.on('data', d => (stdout += d.toString()));
    cp.stderr && cp.stderr.on('data', d => (stderr += d.toString()));
    cp.on('error', (err) => {
      resolve({ ok: false, code: -1, stdout, stderr: String(err && err.message || err) });
    });
    cp.on('close', (code, signal) => {
      resolve({ ok: code === 0, code, signal: signal || null, stdout, stderr });
    });
  });
}

async function which(bin) {
  const r = await run('which', [bin]);
  if (!r.ok) return null;
  const p = r.stdout.trim();
  return p.length ? p : null;
}

function trimLines(s, n = 8) {
  const lines = (s || '').split(/\r?\n/);
  const head = lines.slice(0, n);
  const more = lines.length > n ? `\n...(${lines.length - n} more lines)` : '';
  return (head.join('\n') + more).trim();
}

async function testDirectExec(tmpdir) {
  const res = {};
  res.pwd = await run('pwd');
  res.echo = await run('echo', ['hello']);
  // connectors as args (expected: not supported)
  res.connectors = await run('true', ['&&', 'echo', 'ok']);
  // pipe as args (expected: not supported)
  res.pipe = await run('echo', ['1', '|', 'wc', '-l']);
  // redirection as args (expected: not supported)
  const redirTarget = path.join(tmpdir, 'direct_redir.txt');
  res.redirection = await run('bash', ['-lc', `echo placeholder > ${redirTarget} ; true`]);
  // glob without shell (expected: not expanded)
  const testDir = path.join(tmpdir, 'g');
  await run('mkdir', ['-p', testDir]);
  await run('sh', ['-lc', `: > ${testDir}/a.txt; : > ${testDir}/b.txt`]);
  res.glob = await run('ls', [`${testDir}/*.txt`]);
  // cd as external (expected: not available)
  res.cd = await run('cd', ['..']);
  return {
    pwd: { ok: res.pwd.ok, out: trimLines(res.pwd.stdout) },
    echo: { ok: res.echo.ok, out: trimLines(res.echo.stdout) },
    connectors_supported: false,
    connectors_probe: { ok: res.connectors.ok, code: res.connectors.code, err: trimLines(res.connectors.stderr) },
    pipe_supported: false,
    pipe_probe: { ok: res.pipe.ok, code: res.pipe.code, out: trimLines(res.pipe.stdout), err: trimLines(res.pipe.stderr) },
    redirection_supported: false,
    redirection_probe_note: 'Performed via bash -lc to create file; direct exec alone cannot redirect.',
    glob_supported: false,
    glob_probe: { ok: res.glob.ok, code: res.glob.code, out: trimLines(res.glob.stdout), err: trimLines(res.glob.stderr) },
    cd_supported: false,
    cd_probe: { ok: res.cd.ok, code: res.cd.code, err: trimLines(res.cd.stderr) },
  };
}

async function testBash(tmpdir, bashPath) {
  const sh = bashPath || 'bash';
  const out = {};
  // pipe
  const pipe = await run(sh, ['-lc', 'echo hello | wc -c']);
  // connectors
  const connectors = await run(sh, ['-lc', 'true && echo ok || echo bad']);
  // background &
  const background = await run(sh, ['-lc', 'sleep 0.2 & echo done && wait']);
  // redirection
  const f = path.join(tmpdir, 'redir.txt');
  await run(sh, ['-lc', `echo hi > ${f}`]);
  const redirRead = await run(sh, ['-lc', `cat ${f}`]);
  // glob
  const gdir = path.join(tmpdir, 'g2');
  await run(sh, ['-lc', `mkdir -p ${gdir} ; : > ${gdir}/x.js ; : > ${gdir}/y.js`]);
  const glob = await run(sh, ['-lc', `ls ${gdir}/*.js | wc -l`]);
  // subshell
  const subshell = await run(sh, ['-lc', '(echo A; echo B) | tr "\n" ","']);
  // heredoc
  const hfile = path.join(tmpdir, 'here.txt');
  const heredoc = await run(sh, ['-lc', `cat > ${hfile} <<'EOF'\nline1\nline2\nEOF\ncat ${hfile} | wc -l`]);

  out.available = true;
  out.pipe = { ok: pipe.ok, out: trimLines(pipe.stdout) };
  out.connectors = { ok: connectors.ok, out: trimLines(connectors.stdout) };
  out.background = { ok: background.ok, out: trimLines(background.stdout) };
  out.redirection = { ok: redirRead.ok, out: trimLines(redirRead.stdout) };
  out.glob = { ok: glob.ok, out: trimLines(glob.stdout) };
  out.subshell = { ok: subshell.ok, out: trimLines(subshell.stdout) };
  out.heredoc = { ok: heredoc.ok, out: trimLines(heredoc.stdout) };
  return out;
}

async function testZsh(tmpdir, zshPath) {
  const sh = zshPath || 'zsh';
  const r = await run(sh, ['-c', 'echo Z | wc -c']);
  return { available: r.code !== -1, pipe: { ok: r.ok, out: trimLines(r.stdout) } };
}

async function main() {
  const summary = {
    platform: { os: os.platform(), release: os.release(), arch: os.arch(), shellEnv: process.env.SHELL || null },
    shells: {},
    features: {},
  };
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), 'rcx-exec-check-'));
  try {
    // detect shells
    summary.shells.bash = await which('bash');
    summary.shells.zsh = await which('zsh');
    summary.shells.sh = await which('sh');
    summary.shells.fish = await which('fish');

    // versions (best-effort)
    const bashV = summary.shells.bash ? await run('bash', ['--version']) : { ok: false };
    const zshV = summary.shells.zsh ? await run('zsh', ['--version']) : { ok: false };
    summary.shells.bash_version = bashV.ok ? trimLines(bashV.stdout.split('\n')[0]) : null;
    summary.shells.zsh_version = zshV.ok ? trimLines(zshV.stdout.split('\n')[0]) : null;

    // Direct exec tests (argv, no shell semantics)
    summary.features.direct = await testDirectExec(tmpdir);

    // Bash tests
    if (summary.shells.bash) {
      summary.features.bash = await testBash(tmpdir, summary.shells.bash);
    } else {
      summary.features.bash = { available: false };
    }

    // zsh quick test
    if (summary.shells.zsh) {
      summary.features.zsh = await testZsh(tmpdir, summary.shells.zsh);
    } else {
      summary.features.zsh = { available: false };
    }

    // Final concise flags for quick read
    summary.quick = {
      direct_exec: true,
      supports_connectors_without_shell: false,
      supports_pipe_without_shell: false,
      bash_available: !!summary.shells.bash,
      bash_pipe: !!(summary.features.bash && summary.features.bash.pipe && summary.features.bash.pipe.ok),
      bash_connectors: !!(summary.features.bash && summary.features.bash.connectors && summary.features.bash.connectors.ok),
      bash_background: !!(summary.features.bash && summary.features.bash.background && summary.features.bash.background.ok),
      bash_redirection: !!(summary.features.bash && summary.features.bash.redirection && summary.features.bash.redirection.ok),
      bash_glob: !!(summary.features.bash && summary.features.bash.glob && summary.features.bash.glob.ok),
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('exec-capability-check error:', err);
    process.exitCode = 1;
  } finally {
    // cleanup
    try { await rm(tmpdir, { recursive: true, force: true }); } catch {}
  }
}

main();

