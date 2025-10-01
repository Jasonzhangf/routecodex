#!/usr/bin/env node
// Minimal RouteCodex config CLI (ESM)
// Commands:
//   rc-config validate <path> [--json]
//   rc-config print-merged <path>
//   rc-config why --route <name> --target <provider.model.keyN> <path>

import fs from 'fs';
import path from 'path';

async function loadCompat() {
  try { return await import('@routecodex/config-compat'); }
  catch {
    // local fallback (workspaces/dev)
    const local = path.resolve(process.cwd(), 'sharedmodule', 'config-compat', 'dist', 'index.js');
    return await import(local);
  }
}

function readConfigFile(p) {
  const abs = path.resolve(p.replace(/^~/, process.env.HOME || ''));
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=');
      args[k] = v ?? true;
    } else { args._.push(a); }
  }
  return args;
}

async function cmdValidate(configPath, jsonOut) {
  const compat = await loadCompat();
  const engine = compat.createCompatibilityEngine(compat.DEFAULT_COMPATIBILITY_OPTIONS);
  const cfg = readConfigFile(configPath);
  const res = await engine.processCompatibility(cfg);
  const errors = (res.errors || []).concat(res.compatibilityWarnings?.filter(w => w.severity === 'error') || []);
  const warns = (res.warnings || []).concat(res.compatibilityWarnings?.filter(w => w.severity !== 'error') || []);
  const out = {
    isValid: res.isValid && errors.length === 0,
    errorCount: errors.length,
    warningCount: warns.length,
    errors,
    warnings: warns,
  };
  if (jsonOut) { console.log(JSON.stringify(out, null, 2)); }
  else {
    console.log(`isValid=${out.isValid} errors=${out.errorCount} warnings=${out.warningCount}`);
    if (out.errorCount) console.table(out.errors.map(e => ({ code: e.code, message: e.message, path: e.path || e.instancePath || '' })));
    if (out.warningCount) console.table(out.warnings.map(w => ({ code: w.code, severity: w.severity || 'info', message: w.message, path: w.path || '' })));
  }
}

async function cmdPrintMerged(configPath) {
  const compat = await loadCompat();
  const engine = compat.createCompatibilityEngine(compat.DEFAULT_COMPATIBILITY_OPTIONS);
  const cfg = readConfigFile(configPath);
  const res = await engine.processCompatibility(cfg);
  if (!res.isValid) {
    console.error('Validation failed. Run rc-config validate first.');
    process.exit(2);
  }
  // Output normalized + derived structures (not full project merged-config)
  const cc = res.compatibilityConfig || {};
  const payload = {
    version: '1.0.0',
    mergedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    engineVersion: 'sharedmodule',
    virtualrouter: {
      providers: (cc.normalizedConfig?.virtualrouter?.providers) || {},
      routing: (cc.normalizedConfig?.virtualrouter?.routing) || {},
      routeTargets: cc.routeTargets || {},
      pipelineConfigs: cc.pipelineConfigs || {},
      authMappings: cc.authMappings || {},
    }
  };
  console.log(JSON.stringify(payload, null, 2));
}

async function cmdWhy(route, target, configPath) {
  const compat = await loadCompat();
  const engine = compat.createCompatibilityEngine(compat.DEFAULT_COMPATIBILITY_OPTIONS);
  const cfg = readConfigFile(configPath);
  const res = await engine.processCompatibility(cfg);
  if (!res.isValid) {
    console.error('Validation failed. Run rc-config validate first.');
    process.exit(2);
  }
  const cc = res.compatibilityConfig || {};
  const rt = cc.routeTargets || {};
  const pc = cc.pipelineConfigs || {};
  const targets = rt[route] || [];
  const [prov, model, keyId] = target.split('.');
  const found = targets.find(t => t.providerId === prov && t.modelId === model && (!keyId || t.keyId === keyId));
  const key = keyId ? `${prov}.${model}.${keyId}` : `${prov}.${model}.key1`;
  const hasPipeline = Boolean(pc[key]);
  const diagnostics = {
    route,
    queryTarget: { providerId: prov, modelId: model, keyId: keyId || '(any)' },
    routeTargetsCount: targets.length,
    routeTargetFound: Boolean(found),
    pipelineKeyChecked: key,
    pipelineExists: hasPipeline,
  };
  console.log(JSON.stringify(diagnostics, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    console.log(`Usage:\n  rc-config validate <config.json> [--json]\n  rc-config print-merged <config.json>\n  rc-config why --route <name> --target <provider.model.keyN> <config.json>`);
    process.exit(0);
  }

  try {
    if (cmd === 'validate') {
      const p = args._[1];
      await cmdValidate(p, Boolean(args.json));
    } else if (cmd === 'print-merged') {
      const p = args._[1];
      await cmdPrintMerged(p);
    } else if (cmd === 'why') {
      const route = args.route || args.r;
      const target = args.target || args.t;
      const p = args._[1];
      if (!route || !target || !p) throw new Error('why requires --route, --target and <config.json>');
      await cmdWhy(route, target, p);
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (e) {
    console.error('CLI error:', e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

main();

