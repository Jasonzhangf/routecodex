#!/usr/bin/env node
// Deterministic claw deployment projection of an authoring V3 config.
//
// This file owns exactly two transforms and fails closed on anything else:
//   1. every `[servers.<id>]` root table binds the requested bind address
//   2. the provider ids referenced by route tiers are reported to the caller
//
// It is a declared deployment projection, not a general config rewriter: the
// input config is the authoring truth, the output config is the runtime truth
// for one managed host. Unknown table shapes are rejected rather than passed
// through, and the bind rewrite is count-asserted against the number of root
// server tables.
//
// Usage:
//   node project-claw-config.mjs --input <config.toml> --output <config.toml>
//                                --bind <addr> [--providers-dir <dir>]
//
// stdout is a key=value stream consumed by the caller:
//   version=<n>
//   provider=<id>      (one line per referenced provider, sorted, unique)
//   port=<n>           (one line per root server table, config order)
// stderr carries diagnostics only.

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`[project-claw-config] FAIL ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { bind: '127.0.0.1', providersDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case '--input':
        options.input = value;
        index += 1;
        break;
      case '--output':
        options.output = value;
        index += 1;
        break;
      case '--bind':
        options.bind = value;
        index += 1;
        break;
      case '--providers-dir':
        options.providersDir = value;
        index += 1;
        break;
      default:
        fail(`unsupported argument: ${token}`);
    }
  }
  if (!options.input) fail('--input is required');
  if (!options.output) fail('--output is required');
  if (!options.bind) fail('--bind must not be empty');
  return options;
}

// TOML bare keys allow A-Z, a-z, 0-9, `_` and `-`, and `servers` is a map of
// arbitrary bare keys, so hyphens are legal server ids.
const ROOT_SERVER_TABLE = /^servers\.([A-Za-z0-9_-]+)$/u;
const TABLE_HEADER = /^\[([^\]]+)\]\s*$/u;
const BIND_LINE = /^bind\s*=\s*"([^"]*)"\s*$/u;
const PORT_LINE = /^port\s*=\s*(\d+)\s*$/u;
const ROUTE_USE = /use\s*=\s*"([A-Za-z0-9_.-]+)\/([^"]+)"/gu;

function project({ input, output, bind, providersDir }) {
  if (!fs.existsSync(input)) fail(`input config missing: ${input}`);
  const source = fs.readFileSync(input, 'utf8');
  const lines = source.split('\n');

  const out = [];
  const providers = new Set();
  const ports = [];
  const bindRewrites = new Map();
  let currentRoot = null;
  let serverTables = 0;

  for (const line of lines) {
    const header = TABLE_HEADER.exec(line);
    if (header) {
      const table = header[1];
      const root = ROOT_SERVER_TABLE.exec(table);
      currentRoot = root ? root[1] : null;
      if (root) {
        serverTables += 1;
        bindRewrites.set(root[1], 0);
      }
      out.push(line);
      continue;
    }

    if (currentRoot !== null) {
      const bindMatch = BIND_LINE.exec(line);
      if (bindMatch) {
        out.push(`bind = "${bind}"`);
        bindRewrites.set(currentRoot, bindRewrites.get(currentRoot) + 1);
        continue;
      }
      const port = PORT_LINE.exec(line);
      if (port) ports.push(port[1]);
    }

    for (const match of line.matchAll(ROUTE_USE)) providers.add(match[1]);
    out.push(line);
  }

  if (serverTables === 0) fail('input config declares no [servers.<id>] root table');

  const malformed = [...bindRewrites.entries()].filter(([, count]) => count !== 1);
  if (malformed.length > 0) {
    fail(
      `every [servers.<id>] root table must declare exactly one bind; got ${malformed
        .map(([id, count]) => `${id}=${count}`)
        .join(', ')}`,
    );
  }
  if (ports.length !== serverTables) {
    fail(`every [servers.<id>] root table must declare exactly one port; tables=${serverTables} ports=${ports.length}`);
  }
  if (providers.size === 0) fail('input config references no route provider');

  // Fail closed on the invariant this projection exists to enforce. A bind
  // line that did not get rewritten keeps its authoring address, so the host
  // would listen publicly instead of behind the edge. That is exactly what an
  // unrecognized root server table (e.g. a quoted TOML key) would produce.
  const unrewritten = out
    .map((line, index) => [BIND_LINE.exec(line), index + 1])
    .filter(([match]) => match && match[1] !== bind);
  if (unrewritten.length > 0) {
    fail(
      `projected config binds ${unrewritten
        .map(([match, line]) => `'${match[1]}' at line ${line}`)
        .join(', ')}; every listener must bind ${bind}`,
    );
  }

  const sortedProviders = [...providers].sort();
  if (providersDir) {
    const missing = sortedProviders.filter(
      (id) => !fs.existsSync(path.join(providersDir, id, 'config.v2.toml')),
    );
    if (missing.length > 0) {
      fail(`referenced provider config missing under ${providersDir}: ${missing.join(', ')}`);
    }
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, out.join('\n'));

  const report = [`version=3`, ...sortedProviders.map((id) => `provider=${id}`), ...ports.map((p) => `port=${p}`)];
  process.stdout.write(`${report.join('\n')}\n`);
  process.stderr.write(
    `[project-claw-config] OK servers=${serverTables} providers=${sortedProviders.length} bind=${bind}\n`,
  );
}

project(parseArgs(process.argv.slice(2)));
