import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");

assert.match(source, /<select id="port-filter"><option value="all">all ports<\/option>/);
assert.match(source, /<select id="model-filter"><option value="all">all models<\/option>/);
assert.match(source, /populateFacetSelect\("model-filter", state\.facets\.models \|\| \{\}, "all models"\)/);
assert.match(source, /const model = document\.getElementById\("model-filter"\)\.value;/);
assert.match(source, /if \(model !== "all"\) params\.set\("model", model\);/);

console.log("requests model/port filter smoke passed");
