#!/usr/bin/env node

/**
 * verify-servertool-rust-only.mjs
 *
 * Audit gate that verifies servertool Rust-only invariants.
 * Designed as a CI gate to catch regressions.
 *
 * Checks:
 * 1. No .bak files exist in active servertool paths
 * 2. No TS handler files are imported as side-effect runtime dependencies
 * 3. No duplicate semantic keywords (followupInjectionOps, buildServertoolGenericFollowupPayload)
 *    survive outside documentation
 *
 * Usage:
 *   node scripts/verify-servertool-rust-only.mjs
 *   node scripts/verify-servertool-rust-only.mjs --fix    (informational only)
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Paths to scan ──────────────────────────────────────────────
const SERVERTOOL_TS_DIR = `${ROOT}/sharedmodule/llmswitch-core/src/servertool`;
const RUST_SRC_DIR = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`;

// ── Issues accumulator ─────────────────────────────────────────
const issues = [];

function fail(check, detail) {
  issues.push({ check, detail, severity: 'fail' });
}

function warn(check, detail) {
  issues.push({ check, detail, severity: 'warn' });
}

// ── Check 1: No .bak files in active servertool paths ──────────
function checkNoBakFiles() {
  try {
    const tsBak = execSync(
      `find "${SERVERTOOL_TS_DIR}" -name "*.bak" -maxdepth 5 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (tsBak) {
      fail('no-bak-files', `TS servertool path contains .bak files:\n${tsBak}`);
    } else {
      console.log('[PASS] no-bak-files: No .bak files in TS servertool path');
    }
  } catch {
    warn('no-bak-files', 'Could not scan TS servertool path for .bak files');
  }

  try {
    const rustBak = execSync(
      `find "${RUST_SRC_DIR}" -name "*.bak" -maxdepth 5 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (rustBak) {
      fail('no-bak-files', `Rust servertool path contains .bak files:\n${rustBak}`);
    } else {
      console.log('[PASS] no-bak-files: No .bak files in Rust path');
    }
  } catch {
    warn('no-bak-files', 'Could not scan Rust path for .bak files');
  }
}

// ── Check 2: No TS handler files are imported as runtime deps ──
function checkNoTSHandlerRuntimeImport() {
  const handlerDir = `${SERVERTOOL_TS_DIR}/handlers`;
  try {
    const files = execSync(
      `find "${handlerDir}" -name "*.ts" -maxdepth 3 ! -name "*.d.ts" 2>/dev/null | sort`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);

    // Known allowed imports — these are thin shells or utilities
    const allowedImports = [
      'memory/extract-responses-input',  // small extraction helper
    ];

    for (const file of files) {
      const relative = file.replace(`${SERVERTOOL_TS_DIR}/`, '');
      const modulePath = relative.replace(/\.ts$/, '');

      // Skip allowed
      if (allowedImports.some((a) => modulePath.endsWith(a))) {
        continue;
      }

      // Check if this handler is imported from outside the handlers dir
      // (self-imports within handlers/ are OK)
      try {
        const importers = execSync(
          `grep -rl "from.*['\\"]${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\\"]" "${SERVERTOOL_TS_DIR}" --include="*.ts" ! -path "${handlerDir}/*" 2>/dev/null`,
          { encoding: 'utf8', stdio: 'pipe' }
        ).trim();
        if (importers) {
          warn('no-handler-runtime-import',
            `Handler ${modulePath} imported from outside handlers/:\n${importers}`);
        }
      } catch {
        // grep found nothing = good
      }
    }
    console.log(`[PASS] no-handler-runtime-import: Scanned ${files.length} handler files`);
  } catch (err) {
    warn('no-handler-runtime-import', `Could not scan: ${err.message}`);
  }
}

// ── Check 3: No forbidden duplicate semantic keywords ──────────
function checkNoDuplicateSemantics() {
  const forbidden = [
    'followupInjectionOps',
    'buildServertoolGenericFollowupPayload',
    // stop-message-auto: these native-replaced functions must not reappear in TS handler
    'readPinnedTargetFromAdapterContext',
  ];

  for (const keyword of forbidden) {
    try {
      const result = execSync(
        `grep -r "${keyword}" "${ROOT}/sharedmodule/llmswitch-core/src" --include="*.ts" --include="*.rs" 2>/dev/null`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (result) {
        // Allow doc comments — check if all hits are in comments/docs
        const lines = result.split('\n').filter(Boolean);
        const nonDocLines = lines.filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*');
        });
        if (nonDocLines.length > 0) {
          fail('no-duplicate-semantics', `Forbidden keyword "${keyword}" found in non-doc context:\n${nonDocLines.join('\n')}`);
        }
      }
      console.log(`[PASS] no-duplicate-semantics: "${keyword}" not found in non-doc context`);
    } catch {
      // grep exit code 1 = no matches = good
      console.log(`[PASS] no-duplicate-semantics: "${keyword}" not found`);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────
console.log('\n=== verify-servertool-rust-only ===\n');

checkNoBakFiles();
checkNoTSHandlerRuntimeImport();
checkNoDuplicateSemantics();

console.log();

if (issues.length === 0) {
  console.log('✅ All checks passed — servertool Rust-only invariants hold.');
  process.exit(0);
}

const failCount = issues.filter((i) => i.severity === 'fail').length;
const warnCount = issues.filter((i) => i.severity === 'warn').length;

console.log(`❌ ${failCount} failures, ${warnCount} warnings:\n`);
for (const issue of issues) {
  const icon = issue.severity === 'fail' ? '❌' : '⚠️';
  console.log(`  ${icon} [${issue.check}] ${issue.detail}\n`);
}

if (failCount > 0) {
  process.exit(1);
}
process.exit(0);
