#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const CORE_SRC_PREFIX = 'sharedmodule/llmswitch-core/src/';
const CORE_PACKAGE_JSON = 'sharedmodule/llmswitch-core/package.json';

const GENERATED_DIR_NAMES = new Set([
  'dist',
  'target',
  'coverage',
  'node_modules',
  '.mempalace',
  '.local-index',
  'mempalace',
]);

const MODULE_LOADER_FORBIDDEN_PATTERNS = [
  {
    pattern: /ROUTECODEX_LLMS_ENGINE_/u,
    message: 'module-loader must not keep ROUTECODEX_LLMS_ENGINE_* routing',
  },
  {
    pattern: /rcc-llmswitch-engine/u,
    message: 'module-loader must not reference rcc-llmswitch-engine',
  },
  {
    pattern: /\bresolveImplForSubpath\b/u,
    message: 'module-loader must not expose resolveImplForSubpath',
  },
  {
    pattern: /\bshouldPreferSourceInJest\b/u,
    message: 'module-loader must not prefer TS source in Jest',
  },
  {
    pattern: /\bresolveBuiltinSourceModulePath\b/u,
    message: 'module-loader must not resolve builtin TS source modules',
  },
];

const PACKAGE_EXPORT_FORBIDDEN = [
  {
    key: '.',
    message: 'llmswitch-core package exports must not expose root TypeScript barrel',
  },
  {
    key: './conversion/switch-orchestrator',
    message: 'llmswitch-core package exports must not expose deleted switch-orchestrator shell',
  },
  {
    key: './v2/*',
    message: 'llmswitch-core package exports must not expose broad ./v2/* wildcard',
  },
];

function parseArgs(argv) {
  const args = { json: false, strict: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--strict') {
      args.strict = true;
      continue;
    }
    throw new Error(`unknown arg: ${token}`);
  }
  return args;
}

function readGitTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'))
    .sort();
}

function isGeneratedOrLocalIndexPath(rel) {
  return rel.split('/').some((part) => GENERATED_DIR_NAMES.has(part));
}

function isProdTsShell(rel) {
  if (!rel.startsWith(CORE_SRC_PREFIX)) return false;
  if (!rel.endsWith('.ts')) return false;
  if (rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return false;
  if (rel.includes('/tests/') || rel.includes('/test/') || rel.includes('/archive/')) return false;
  if (isGeneratedOrLocalIndexPath(rel)) return false;
  return fs.existsSync(path.join(ROOT, rel));
}

function isSourceFile(rel) {
  if (!fs.existsSync(path.join(ROOT, rel))) return false;
  if (isGeneratedOrLocalIndexPath(rel)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|yml|yaml|md)$/u.test(rel);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function resolveStaticImport(from, spec, shellByModuleSpec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]) {
    const shell = shellByModuleSpec.get(candidate);
    if (shell) return shell;
  }
  return null;
}

function categorizeFile(rel) {
  if (rel.startsWith('src/modules/llmswitch/bridge/')) return 'host-bridge';
  if (rel.startsWith('src/')) return 'host-src';
  if (rel.startsWith('sharedmodule/llmswitch-core/src/')) return 'core-src';
  if (rel.startsWith('sharedmodule/llmswitch-core/tests/')) return 'core-tests';
  if (rel.startsWith('tests/')) return 'root-tests';
  if (rel.startsWith('scripts/')) return 'scripts';
  if (rel.startsWith('docs/architecture/')) return 'arch-docs';
  if (rel.startsWith('docs/')) return 'docs';
  if (rel.endsWith('package.json')) return 'package';
  return 'other';
}

function summarizeCategories(files) {
  const counts = {};
  for (const file of files) {
    const category = categorizeFile(file);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function buildReferenceGraph(files) {
  const shells = files.filter(isProdTsShell);
  const shellByModuleSpec = new Map();
  for (const shell of shells) {
    shellByModuleSpec.set(shell, shell);
    shellByModuleSpec.set(shell.replace(/\.ts$/u, ''), shell);
    shellByModuleSpec.set(shell.replace(/\.ts$/u, '.js'), shell);
  }

  const sourceFiles = files.filter(isSourceFile);
  const importers = new Map(shells.map((shell) => [shell, []]));
  const exactTextRefs = new Map(shells.map((shell) => [shell, []]));
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gu;

  for (const file of sourceFiles) {
    const source = readText(file);
    let match;
    while ((match = importPattern.exec(source))) {
      const spec = match[1] || match[2];
      const target = resolveStaticImport(file, spec, shellByModuleSpec);
      if (target) importers.get(target).push(file);
    }

    for (const shell of shells) {
      const moduleSpec = shell.replace(CORE_SRC_PREFIX, '').replace(/\.ts$/u, '');
      const srcJs = shell.replace(/\.ts$/u, '.js');
      const distJs = shell.replace(CORE_SRC_PREFIX, 'sharedmodule/llmswitch-core/dist/').replace(/\.ts$/u, '.js');
      if (
        file !== shell &&
        (source.includes(shell) ||
          source.includes(srcJs) ||
          source.includes(distJs) ||
          source.includes(moduleSpec))
      ) {
        exactTextRefs.get(shell).push(file);
      }
    }
  }

  return shells.map((shell) => {
    const allImporters = Array.from(new Set(importers.get(shell))).sort();
    const prodImporters = allImporters.filter((file) =>
      !file.startsWith('tests/') &&
      !file.startsWith('sharedmodule/llmswitch-core/tests/') &&
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.test.ts')
    );
    const textRefs = Array.from(new Set(exactTextRefs.get(shell))).sort();
    const hostRefs = textRefs.filter((file) =>
      file.startsWith('src/modules/llmswitch/bridge/') ||
      file.startsWith('src/providers/') ||
      file.startsWith('src/server/')
    );
    return {
      shell,
      importRefs: allImporters.length,
      prodImportRefs: prodImporters.length,
      hostTextRefs: hostRefs.length,
      exactTextRefs: textRefs.length,
      prodImporters,
      hostRefs,
      refCategories: summarizeCategories(textRefs),
    };
  });
}

function collectCoreModuleSubpathReferences(files) {
  const refs = [];
  const pattern = /\b(?:requireCoreDist|importCoreDist|importCoreModule|resolveCoreModulePath|resolveCoreModuleUrl)\s*(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/gu;
  for (const file of files.filter(isSourceFile)) {
    const source = readText(file);
    let match;
    while ((match = pattern.exec(source))) {
      refs.push({
        file,
        category: categorizeFile(file),
        subpath: match[1].replace(/^\/*/u, '').replace(/\.js$/iu, ''),
      });
    }
  }
  return refs.sort((a, b) => `${a.subpath}:${a.file}`.localeCompare(`${b.subpath}:${b.file}`));
}

function collectPackageExportErrors() {
  const errors = [];
  const pkg = JSON.parse(readText(CORE_PACKAGE_JSON));
  const exportsMap = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {};
  for (const rule of PACKAGE_EXPORT_FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(exportsMap, rule.key)) {
      errors.push(rule.message);
    }
  }
  return errors;
}

function collectModuleLoaderErrors(files) {
  const errors = [];
  for (const rel of [
    'src/modules/llmswitch/bridge/module-loader.ts',
    'src/modules/llmswitch/bridge/module-loader.js',
    'src/modules/llmswitch/bridge/module-loader.d.ts',
  ]) {
    if (!files.includes(rel)) continue;
    const source = readText(rel);
    for (const rule of MODULE_LOADER_FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(source)) {
        errors.push(`${rel}: ${rule.message}`);
      }
    }
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv);
  const files = readGitTrackedFiles();
  const graph = buildReferenceGraph(files);
  const subpathRefs = collectCoreModuleSubpathReferences(files);
  const errors = [
    ...collectModuleLoaderErrors(files),
    ...collectPackageExportErrors(),
  ];
  const result = {
    ok: errors.length === 0,
    errors,
    metrics: {
      prodTsShellCount: graph.length,
      shellsWithProdImporters: graph.filter((entry) => entry.prodImportRefs > 0).length,
      shellsWithHostTextRefs: graph.filter((entry) => entry.hostTextRefs > 0).length,
      coreModuleSubpathRefs: subpathRefs.length,
    },
    graph,
    coreModuleSubpathRefs: subpathRefs,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[llmswitch-ts-shell-reference-audit]');
    console.log(`- prodTsShellCount=${result.metrics.prodTsShellCount}`);
    console.log(`- shellsWithProdImporters=${result.metrics.shellsWithProdImporters}`);
    console.log(`- shellsWithHostTextRefs=${result.metrics.shellsWithHostTextRefs}`);
    console.log(`- coreModuleSubpathRefs=${result.metrics.coreModuleSubpathRefs}`);
    if (errors.length > 0) {
      console.error('[llmswitch-ts-shell-reference-audit] FAILED');
      for (const error of errors) console.error(`- ${error}`);
    } else {
      console.log('[llmswitch-ts-shell-reference-audit] OK');
    }
  }

  if (args.strict && errors.length > 0) {
    process.exit(2);
  }
}

main();
