import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");

assert.match(source, /<select id="port-filter"><option value="all">all ports<\/option>/);
assert.match(source, /<select id="provider-filter"><option value="all">all providers<\/option>/);
assert.match(source, /<select id="model-filter"><option value="all">all models<\/option>/);
assert.match(source, /<select id="endpoint-filter"><option value="all">all endpoints<\/option>/);
assert.match(source, /<label>Route<input id="route-filter" type="search" placeholder="route"><\/label>/);
assert.match(source, /populateFacetSelect\("provider-filter", state\.facets\.providers \|\| \{\}, "all providers"\)/);
assert.match(source, /populateFacetSelect\("model-filter", state\.facets\.models \|\| \{\}, "all models"\)/);
assert.match(source, /populateFacetSelect\("endpoint-filter", state\.facets\.endpoints \|\| \{\}, "all endpoints"\)/);
assert.match(source, /const model = document\.getElementById\("model-filter"\)\.value;/);
assert.match(source, /if \(model !== "all"\) params\.set\("model", model\);/);
assert.match(source, /const provider = document\.getElementById\("provider-filter"\)\.value;/);
assert.match(source, /if \(provider !== "all"\) params\.set\("provider", provider\);/);
assert.match(source, /const endpoint = document\.getElementById\("endpoint-filter"\)\.value;/);
assert.match(source, /if \(endpoint !== "all"\) params\.set\("endpoint", endpoint\);/);
assert.match(source, /const route = document\.getElementById\("route-filter"\)\.value\.trim\(\);/);
assert.match(source, /if \(route\) params\.set\("route", route\);/);

console.log("requests provider/model/port/endpoint filter smoke passed");
