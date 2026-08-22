#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = {
    file: '.beads/issues.jsonl',
    apply: false,
    maxBytes: 64 * 1024,
    maxNoteChars: 4000,
    backup: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--no-backup') {
      options.backup = false;
      continue;
    }
    if (arg === '--file' && argv[i + 1]) {
      options.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--max-bytes' && argv[i + 1]) {
      options.maxBytes = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-note-chars' && argv[i + 1]) {
      options.maxNoteChars = Number(argv[i + 1]);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`Invalid --max-bytes: ${options.maxBytes}`);
  }
  if (!Number.isFinite(options.maxNoteChars) || options.maxNoteChars <= 64) {
    throw new Error(`Invalid --max-note-chars: ${options.maxNoteChars}`);
  }

  return options;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function compactNotes(notes, maxNoteChars) {
  const normalized = String(notes || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return normalized;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const summaryLines = [];
  let remaining = maxNoteChars;
  for (const line of lines) {
    const next = summaryLines.length === 0 ? line : `\n${line}`;
    if (next.length > remaining) {
      break;
    }
    summaryLines.push(line);
    remaining -= next.length;
  }

  let compacted = summaryLines.join('\n').trim();
  if (!compacted) {
    compacted = normalized.slice(0, Math.max(256, maxNoteChars - 160)).trim();
  }

  const suffix =
    '\n[compacted by cleanup-beads-oversized-notes.mjs: raw build/test logs removed; keep detailed output in artifacts, MEMORY.md, or dedicated log files]';
  const allowed = Math.max(128, maxNoteChars - suffix.length);
  if (compacted.length > allowed) {
    compacted = compacted.slice(0, allowed).trimEnd();
  }
  return `${compacted}${suffix}`;
}

function compactRecordLine(line, maxBytes, maxNoteChars) {
  const parsed = JSON.parse(line);
  const originalNotes = typeof parsed.notes === 'string' ? parsed.notes : '';
  if (!originalNotes) {
    return { changed: false, line };
  }

  const originalBytes = byteLength(line);
  if (originalBytes <= maxBytes && originalNotes.length <= maxNoteChars) {
    return { changed: false, line };
  }

  let nextNotes = compactNotes(originalNotes, maxNoteChars);
  parsed.notes = nextNotes;
  let nextLine = JSON.stringify(parsed, null, 0);

  if (byteLength(nextLine) > maxBytes) {
    const hardLimit = Math.max(256, Math.min(maxNoteChars, Math.floor(maxBytes / 4)));
    nextNotes = compactNotes(originalNotes, hardLimit);
    parsed.notes = nextNotes;
    nextLine = JSON.stringify(parsed, null, 0);
  }

  if (byteLength(nextLine) > maxBytes) {
    const fallbackSuffix =
      '\n[compacted: original notes exceeded storage threshold; see repository artifacts/history for full logs]';
    const prefixBudget = Math.max(128, Math.floor(maxBytes / 6) - fallbackSuffix.length);
    parsed.notes = `${originalNotes.slice(0, prefixBudget).trimEnd()}${fallbackSuffix}`;
    nextLine = JSON.stringify(parsed, null, 0);
  }

  return {
    changed: nextLine !== line,
    line: nextLine,
    id: parsed.id,
    beforeBytes: originalBytes,
    afterBytes: byteLength(nextLine),
    beforeNoteChars: originalNotes.length,
    afterNoteChars: String(parsed.notes || '').length
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(options.file);
  const content = fs.readFileSync(filePath, 'utf8');
  const inputLines = content.split('\n').filter((line) => line.length > 0);

  const outputLines = [];
  const changedRecords = [];

  for (const line of inputLines) {
    const result = compactRecordLine(line, options.maxBytes, options.maxNoteChars);
    outputLines.push(result.line);
    if (result.changed) {
      changedRecords.push(result);
    }
  }

  console.log(`file=${filePath}`);
  console.log(`records=${inputLines.length}`);
  console.log(`changed=${changedRecords.length}`);
  for (const record of changedRecords) {
    console.log(
      [
        `id=${record.id}`,
        `beforeBytes=${record.beforeBytes}`,
        `afterBytes=${record.afterBytes}`,
        `beforeNoteChars=${record.beforeNoteChars}`,
        `afterNoteChars=${record.afterNoteChars}`
      ].join(' ')
    );
  }

  if (!options.apply) {
    console.log('dry-run only; re-run with --apply to rewrite the file');
    return;
  }

  if (options.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.bak.${stamp}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`backup=${backupPath}`);
  }

  fs.writeFileSync(filePath, `${outputLines.join('\n')}\n`, 'utf8');
  console.log('applied=true');
}

main();
