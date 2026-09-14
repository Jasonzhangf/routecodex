import assert from "node:assert/strict";
import fs from "node:fs";

// Filter rail + facet selects live in the view module; the markup shell keeps
// the hidden compatibility select and the panel host.
const markup = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("./app/views/usage.js", import.meta.url), "utf8");

assert.match(markup, /<select id="port-filter"><option value="all">all ports<\/option>/);
assert.match(markup, /<select id="provider-filter"><option value="all">all providers<\/option>/);
assert.match(markup, /<select id="model-filter"><option value="all">all models<\/option>/);
assert.match(markup, /<select id="endpoint-filter"><option value="all">all endpoints<\/option>/);
assert.match(markup, /<label>Route<input id="route-filter" type="search" placeholder="route"><\/label>/);
assert.match(view, /populateFacetSelect\("provider-filter", state\.facets\.providers \|\| \{\}, "all providers"\)/);
assert.match(view, /populateFacetSelect\("model-filter", state\.facets\.models \|\| \{\}, "all models"\)/);
assert.match(view, /populateFacetSelect\("endpoint-filter", state\.facets\.endpoints \|\| \{\}, "all endpoints"\)/);
assert.match(view, /const model = document\.getElementById\("model-filter"\)\.value;/);
assert.match(view, /if \(model !== "all"\) params\.set\("model", model\);/);
assert.match(view, /const provider = document\.getElementById\("provider-filter"\)\.value;/);
assert.match(view, /if \(provider !== "all"\) params\.set\("provider", provider\);/);
assert.match(view, /const endpoint = document\.getElementById\("endpoint-filter"\)\.value;/);
assert.match(view, /if \(endpoint !== "all"\) params\.set\("endpoint", endpoint\);/);
assert.match(view, /const route = document\.getElementById\("route-filter"\)\.value\.trim\(\);/);
assert.match(view, /if \(route\) params\.set\("route", route\);/);

// The rail is opt-out: every value starts checked, so the default view applies
// no filter at all. The four layers are Status / Provider / Model / Error code,
// and each layer's include-set is the whitelist sent to the API.
assert.match(markup, /id="filter-status"/);
assert.match(markup, /id="filter-provider"/);
assert.match(markup, /id="filter-model"/);
assert.match(markup, /id="filter-error-code"/);
assert.match(markup, /data-clear="statusInclude"/);
assert.match(markup, /data-clear="providerInclude"/);
assert.match(markup, /data-clear="modelInclude"/);
assert.match(markup, /data-clear="errorCodeInclude"/);
assert.match(view, /statusInclude: null, *\/\/ null = "not yet seeded"/);
assert.match(view, /providerInclude: null, *\/\/ null = "not yet seeded"/);
assert.match(view, /modelInclude: null, *\/\/ null = "not yet seeded"/);
assert.match(view, /errorCodeInclude: null, *\/\/ null = "not yet seeded"/);
// Seeding: a layer is unconstrained until the unfiltered value list arrives,
// then it is filled with every known value while preserving user unchecks.
assert.match(view, /function seedIncludeSets\(\)/);
assert.match(view, /\["statusInclude", kindKeys\]/);
assert.match(view, /\["providerInclude", Object\.keys\(rail\.providers \|\| \{\}\)\]/);
assert.match(view, /\["modelInclude", Object\.keys\(rail\.models \|\| \{\}\)\]/);
assert.match(view, /\["errorCodeInclude", Object\.keys\(rail\.error_status_codes \|\| \{\}\)\]/);
assert.match(view, /if \(state\[key\] == null\) \{\n      state\[key\] = new Set\(values\);\n    \} else \{\n      for \(const value of values\) \{\n        if \(!seen\.has\(value\)\) state\[key\]\.add\(value\);\n      \}\n    \}/);
assert.match(view, /const seen = state\.knownLayerValues\[key\] \|\| \(state\.knownLayerValues\[key\] = new Set\(\)\);/);
// An unseeded layer must not constrain the query; an emptied layer must hide
// everything; and a fully-checked layer must not cost a query per value.
// The server narrows its facets to the active filter, so the rail also has to
// source its value list from the unfiltered snapshot.
assert.match(view, /if \(set == null\) continue;\n    if \(!set\.size\) return \[\];/);
assert.match(view, /if \(every\.length && every\.every\(\(value\) => set\.has\(value\)\)\) continue;/);
assert.match(view, /const rail = state\.railFacets \|\| state\.facets \|\| \{\};/);
assert.match(view, /async function loadRailFacets\(\)/);
// Re-rendering the whole rail on every load would destroy the checkbox the user
// is interacting with, so unchanged lists are updated in place instead.
assert.match(view, /if \(container\.dataset\.signature === signature\) \{/);
// Unchecking must both drop the value from the whitelist and re-query at once.
assert.match(view, /on \? state\.providerInclude\.add\(value\) : state\.providerInclude\.delete\(value\);\n      state\.page = 1;\n      loadRecords\(\);/);
assert.match(view, /on \? state\.errorCodeInclude\.add\(value\) : state\.errorCodeInclude\.delete\(value\);\n      state\.page = 1;\n      loadRecords\(\);/);
// Error code is a real query layer, not a display-only badge.
assert.match(view, /if \(plan\.errorCode\) params\.set\("error_status_code", plan\.errorCode\);/);

console.log("requests provider/model/port/endpoint filter smoke passed");
