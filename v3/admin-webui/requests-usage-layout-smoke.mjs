import assert from "node:assert/strict";
import fs from "node:fs";

const markup = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("./app/views/usage.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

assert.match(markup, /id="provider-filter"[^>]*>.*all providers/s);
assert.match(markup, /id="model-filter"[^>]*>.*all models/s);
assert.match(markup, /id="port-filter"[^>]*>.*all ports/s);
assert.match(markup, /id="endpoint-filter"[^>]*>.*all endpoints/s);
assert.match(markup, /id="route-filter"[^>]*>/);
assert.match(view, /function hitRateText\(usage\)/);
assert.match(view, /function usageText\(usage\)/);
assert.match(view, /label: "Usage", colClass: "col-usage"/);
assert.match(view, /el\("div", "hit-rate", hitRateText\(usage\)\)/);
assert.doesNotMatch(view, /label: "Hit", colClass: "col-hit"/);
assert.match(styles, /\.request-table td\.col-usage \.hit-rate \{\n  width: 64px;/);
assert.match(styles, /\.request-table td\.col-usage \.usage-value,\n\.request-table td\.col-usage \.hit-rate/);
assert.doesNotMatch(view, /created=\$\{fmtCompact\(created\)\} · \$\{hit\}/);

console.log("requests usage/hit layout smoke passed");
