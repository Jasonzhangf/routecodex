#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const suffix = '_req_process_tool_filters_request_pre.json';
const sampleRoot = process.argv[2] || path.join(os.homedir(), '.routecodex', 'codex-samples');

const SHELL_PATTERNS = {
  read: [
    'ls',
    'dir ',
    'pwd',
    'cat ',
    'type ',
    'head ',
    'tail ',
    'stat',
    'tree',
    'wc ',
    'du ',
    'printf "',
    'python - <<',
    'python -c',
    'node - <<',
    'node -e',
    'codesign --display'
  ],
  search: [
    'rg ',
    'rg-',
    'grep ',
    'grep-',
    'ripgrep',
    'find ',
    'fd ',
    'locate ',
    'search ',
    'codesearch',
    'ack ',
    'ag ',
    'where ',
    'which '
  ],
  write: [
    'apply_patch',
    'sed -i',
    'perl -pi',
    'tee ',
    'cat <<',
    'cat >',
    'printf >',
    'touch ',
    'truncate',
    'mkdir',
    'mktemp',
    'rmdir',
    'rm ',
    'rm -',
    'unlink',
    'mv ',
    'cp ',
    'ln -',
    'chmod',
    'chown',
    'chgrp',
    'tar xf',
    'tar cf',
    'git add',
    'git commit',
    'git apply',
    'git am',
    'git rebase',
    'git checkout',
    'git merge',
    'patch <<',
    'npm install',
    'pnpm install',
    'yarn add',
    'yarn install',
    'pip install',
    'pip3 install',
    'brew install',
    'cargo add',
    'cargo install',
    'go install',
    'make install'
  ]
};

function canonicalizeToolName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  const idx = trimmed.indexOf('arg_');
  if (idx > 0) return trimmed.slice(0, idx);
  return trimmed;
}

function normalizeCommand(cmd) {
  if (!cmd) return '';
  if (Array.isArray(cmd)) return cmd.join(' ');
  if (typeof cmd === 'object') {
    if (cmd.command) return normalizeCommand(cmd.command);
    if (cmd.args) return normalizeCommand(cmd.args);
    try {
    return JSON.stringify(cmd);
  } catch {
    return String(cmd);
  }
  }
  return String(cmd || '').trim();
}

function detectCategory(tool, cmd) {
  if (!tool) return 'other';
  const lowTool = tool.toLowerCase();
  if (lowTool === 'apply_patch') return 'write';
  if (lowTool === 'describe_current_request') return 'read';
  if (lowTool === 'list_mcp_resources' || lowTool === 'list_mcp_tools') return 'other';
  if (lowTool === 'update_plan') return 'other';

  const normalizedCmd = cmd.toLowerCase();
  if (lowTool === 'shell_command' || lowTool === 'shell' || lowTool === 'bash') {
    return detectShellCommandCategory(normalizedCmd);
  }
  if (matchesAny(normalizedCmd, SHELL_PATTERNS.write)) return 'write';
  if (matchesAny(normalizedCmd, SHELL_PATTERNS.search)) return 'search';
  if (matchesAny(normalizedCmd, SHELL_PATTERNS.read)) return 'read';
  return 'other';
}

function detectShellCommandCategory(cmd) {
  if (!cmd) return 'other';
  const segments = splitCommandSegments(cmd);
  if (segments.some((seg) => matchesAny(seg, SHELL_PATTERNS.write))) return 'write';
  if (segments.some((seg) => matchesAny(seg, SHELL_PATTERNS.search))) return 'search';
  if (segments.some((seg) => matchesAny(seg, SHELL_PATTERNS.read))) return 'read';
  return 'other';
}

function splitCommandSegments(cmd) {
  return cmd
    .split(/[\n;&]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function matchesAny(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

async function listCandidateFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listCandidateFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

function extractRequestKey(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^(req_\d+_[^_]+)/);
  return match ? match[1] : base;
}

function ensureSummary(summary, tool) {
  if (!summary.has(tool)) {
    summary.set(tool, {
      total: 0,
      categories: { read: 0, write: 0, search: 0, other: 0 },
      samples: []
    });
  }
  return summary.get(tool);
}

function recordSample(summary, tool, category, command, filePath) {
  const item = ensureSummary(summary, tool);
  item.total += 1;
  item.categories[category] += 1;
  if (item.samples.length < 5) {
    item.samples.push({ category, command, file: path.basename(filePath) });
  }
}

async function main() {
  const protocols = await fs.readdir(sampleRoot, { withFileTypes: true });
  const files = [];
  for (const proto of protocols) {
    if (!proto.isDirectory()) continue;
    const dir = path.join(sampleRoot, proto.name);
    const protoFiles = await listCandidateFiles(dir);
    files.push(...protoFiles);
  }
  files.sort((a, b) => a.localeCompare(b));
  const summary = new Map();
  const processedRequests = new Set();
  for (const filePath of files) {
    const reqKey = extractRequestKey(filePath);
    if (processedRequests.has(reqKey)) {
      continue;
    }
    processedRequests.add(reqKey);
    let data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const msg of messages) {
      if (!msg || msg.role !== 'assistant') continue;
      if (!Array.isArray(msg.tool_calls)) continue;
      for (const call of msg.tool_calls) {
        const name = canonicalizeToolName(call?.function?.name || call?.name || '');
        if (!name) continue;
        let parsedArgs;
        if (typeof call?.function?.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch {
            parsedArgs = undefined;
          }
        } else if (call?.function?.arguments && typeof call.function.arguments === 'object') {
          parsedArgs = call.function.arguments;
        }
        const command = normalizeCommand(parsedArgs?.command || parsedArgs?.input || parsedArgs?.args || parsedArgs);
        const category = detectCategory(name, command);
        recordSample(summary, name, category, command, filePath);
      }
    }
  }

  const result = Array.from(summary.entries())
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.total - a.total);

  console.log(JSON.stringify({ sampleRoot, toolCount: result.length, tools: result }, null, 2));
}

main().catch((err) => {
  console.error('Failed to classify tools:', err);
  process.exit(1);
});
