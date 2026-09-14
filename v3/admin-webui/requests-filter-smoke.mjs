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

console.log("requests provider/model/port/endpoint filter smoke passed");
