import assert from "node:assert/strict";
import fs from "node:fs";

// Saving routes only persists a revision; the running listener keeps its
// startup manifest until the runtime reloads. The routes view must therefore
// own the reload step and must not announce an active configuration before
// reload confirms it.
const view = fs.readFileSync(new URL("./app/views/routes.js", import.meta.url), "utf8");
const core = fs.readFileSync(new URL("./app/core.js", import.meta.url), "utf8");

assert.match(view, /await api\("\/api\/routes", \{ method: "PUT",/);
assert.match(view, /await api\("\/api\/reload", \{ method: "POST" \}\)/);

const saveIndex = view.indexOf('api("/api/routes", { method: "PUT"');
const reloadIndex = view.indexOf('api("/api/reload", { method: "POST" })');
assert.ok(saveIndex !== -1 && reloadIndex !== -1, "save and reload call sites must exist");
assert.ok(saveIndex < reloadIndex, "reload must run after the routes revision is saved");

// Success wording may only appear inside the reload-success branch.
const okAnnounce = /announce\("ok", `Routes saved as revision #\$\{result\.revision_seq\} and runtime reloaded\.`\)/;
assert.match(view, okAnnounce);
assert.match(
  view,
  /catch \(reloadError\) \{\s*announce\("err", `Revision #\$\{result\.revision_seq\} saved but runtime reload failed/,
  "a failed reload must report that the saved revision is not active yet",
);
assert.doesNotMatch(
  view,
  /announce\("ok", `Routes saved as revision #\$\{result\.revision_seq\}\.`\)/,
  "the stale save-only success message must not remain",
);

// The reload owner stays single: the view reuses the declared FastAPI-style
// control endpoint instead of inventing a second reload path.
assert.match(core, /export async function reload\(\)/);
assert.doesNotMatch(view, /routecodex.*restart|spawn|execFile/);

console.log("routes save-then-reload smoke passed");
