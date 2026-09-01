import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

assert.match(source, /id="provider-filter"[^>]*>.*all providers/s);
assert.match(source, /id="model-filter"[^>]*>.*all models/s);
assert.match(source, /id="port-filter"[^>]*>.*all ports/s);
assert.match(source, /id="endpoint-filter"[^>]*>.*all endpoints/s);
assert.match(source, /id="route-filter"[^>]*>/);
assert.match(source, /function hitRateText\(usage\)/);
assert.match(source, /function usageText\(usage\)/);
assert.match(source, /label: "Usage", colClass: "col-usage"/);
assert.match(source, /el\("div", "hit-rate", hitRateText\(usage\)\)/);
assert.doesNotMatch(source, /label: "Hit", colClass: "col-hit"/);
assert.match(styles, /\.request-table td\.col-usage \.hit-rate \{\n  width: 64px;/);
assert.match(styles, /\.request-table td\.col-usage \.usage-value,\n\.request-table td\.col-usage \.hit-rate/);
assert.doesNotMatch(source, /created=\$\{fmtCompact\(created\)\} · \$\{hit\}/);

console.log("requests usage/hit layout smoke passed");
