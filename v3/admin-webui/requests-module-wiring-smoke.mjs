// RCC V3 Admin WebUI — requests view module wiring smoke.
//
// The usage view is split across several ES modules that import from each other.
// A missing named import does not fail when the file is read: it throws a
// ReferenceError the first time that code path runs, which reaches the user as
// "records query failed: <name> is not defined". That regression shipped twice
// while splitting this view, and neither the layout smoke nor the filter smoke
// could see it, so it is linked explicitly here.
//
// Run with: node --experimental-vm-modules requests-module-wiring-smoke.mjs
//
// Node's module linker is used rather than a text scan. Parsing JavaScript with
// regular expressions produced false positives on object keys, destructuring
// defaults, regex literals and prose inside template literals; the linker has
// none of those problems and reports the exact specifier that failed.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

if (typeof vm.SourceTextModule !== "function") {
  console.error("requests view module wiring smoke FAILED: "
    + "run with --experimental-vm-modules so the module linker is available");
  process.exit(1);
}

const viewsDir = new URL("./app/views/", import.meta.url);
const stubUrl = new URL("./test-support/link-stub.js", import.meta.url).href;
const roots = fs.readdirSync(viewsDir).filter((f) => f.endsWith(".js"));

// The views read the DOM and start timers at module scope. Linking does not
// execute the module body, but the linker still resolves every specifier, which
// is the property under test. Relative specifiers resolve against the real
// filesystem so the real import graph is what gets checked.
const cache = new Map();

function link(identifier) {
  if (cache.has(identifier)) return cache.get(identifier);
  const source = fs.readFileSync(new URL(identifier), "utf8");
  const mod = new vm.SourceTextModule(source, {
    identifier,
    initializeImportMeta() {},
  });
  cache.set(identifier, mod);
  return mod;
}

async function linkAll(identifier) {
  const mod = link(identifier);
  if (mod.status === "unlinked") {
    await mod.link((specifier, referencing) => {
      // Only same-directory view modules are ours; every other specifier is
      // stubbed so a missing browser/platform module cannot mask a wiring bug.
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return link(stubUrl);
      }
      const resolved = new URL(specifier, referencing.identifier);
      return link(resolved.href);
    });
  }
  return mod;
}

const failures = [];
for (const file of roots) {
  try {
    await linkAll(new URL(file, viewsDir).href);
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
  }
}

assert.deepEqual(failures, [],
  "modules that do not link (a named import does not resolve to an export):\n  "
  + failures.join("\n  "));

console.log(`requests view module wiring smoke passed (${roots.length} modules linked)`);
