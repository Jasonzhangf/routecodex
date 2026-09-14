import assert from "node:assert/strict";
import fs from "node:fs";

const markup = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");
// The usage view is split across modules, so the usage/hit cell rendering is
// asserted against the module that owns it rather than against the view.
const panels = fs.readFileSync(new URL("./app/views/usage-panels.js", import.meta.url), "utf8");

assert.match(markup, /id="provider-filter"[^>]*>.*all providers/s);
assert.match(markup, /id="model-filter"[^>]*>.*all models/s);
assert.match(markup, /id="port-filter"[^>]*>.*all ports/s);
assert.match(markup, /id="endpoint-filter"[^>]*>.*all endpoints/s);
assert.match(markup, /id="route-filter"[^>]*>/);
assert.match(panels, /function hitRateText\(usage\)/);
assert.match(panels, /function usageText\(usage\)/);
assert.match(panels, /label: "Usage", colClass: "col-usage"/);
assert.match(panels, /el\("div", "hit-rate", hitRateText\(usage\)\)/);
assert.doesNotMatch(panels, /label: "Hit", colClass: "col-hit"/);
assert.match(styles, /\.request-table td\.col-usage \.hit-rate \{\n  width: 64px;/);
assert.match(styles, /\.request-table td\.col-usage \.usage-value,\n\.request-table td\.col-usage \.hit-rate/);
assert.doesNotMatch(panels, /created=\$\{fmtCompact\(created\)\} · \$\{hit\}/);

console.log("requests usage/hit layout smoke passed");
