// RCC V3 Admin WebUI — sidebar shell shared by every page.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/shell.js)

import { el, reload, setAdminToken, showStatus } from "./core.js";

const NAV_ITEMS = [
  ["/", "dashboard", "Dashboard", "Monitoring overview for ports, providers and traffic"],
  ["/requests.html", "usage", "Usage", "Request records, tokens, cache hit rate and errors"],
  ["/providers.html", "providers", "Providers", "Provider inventory, health and references"],
  ["/routes.html", "routes", "Routes", "Routing tiers, pools and weights"],
  ["/deploy.html", "deploy", "Deploy", "Environment, doctor self-check and runtime lifecycle"],
];

let adminSessionPromise = null;

/**
 * Fetch the local admin token once and hand it to core.js, which owns token storage and
 * attaches the header to every `api()` call. shell.js owns fetching; core.js owns storage.
 * Rejects explicitly when the token cannot be provisioned (the server then fails closed).
 */
export function ensureAdminSession() {
  if (!adminSessionPromise) {
    adminSessionPromise = fetch("/api/admin/session", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const text = await response.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        if (!response.ok) {
          throw new Error(body?.error || `admin session unavailable (${response.status})`);
        }
        const token = body?.token || null;
        setAdminToken(token);
        return token;
      })
      .catch((error) => {
        adminSessionPromise = null;
        throw error;
      });
  }
  return adminSessionPromise;
}

/** Mutating fetches must run after the token is available. */
export async function requireAdminSession() {
  const token = await ensureAdminSession();
  if (!token) throw new Error("admin session returned no token");
  return token;
}

// Inject the sidebar, page header actions and status bar scaffold.
export function initShell(active, { title, subtitle } = {}) {
  const sidebar = document.getElementById("sidebar");
  if (sidebar && !sidebar.childElementCount) {
    const brand = el("div", "brand");
    brand.appendChild(document.createTextNode("Route"));
    brand.appendChild(el("span", "accent", "Codex"));
    sidebar.appendChild(brand);
    const nav = el("nav");
    nav.setAttribute("aria-label", "Primary");
    for (const [href, key, label] of NAV_ITEMS) {
      const link = el("a", key === active ? "active" : null, label);
      link.href = href;
      if (key === active) link.setAttribute("aria-current", "page");
      nav.appendChild(link);
    }
    sidebar.appendChild(nav);
    const footer = el("div", "sidebar-foot");
    const version = el("span", "muted tiny", "V3 admin");
    footer.appendChild(version);
    sidebar.appendChild(footer);
  }
  const heading = document.getElementById("page-title");
  if (heading && title) heading.textContent = title;
  const sub = document.getElementById("page-sub");
  if (sub && subtitle) sub.textContent = subtitle;
  document.getElementById("reload-btn")?.addEventListener("click", reload);
  document.documentElement.classList.add("ambient");
  ensureAdminSession().catch((error) => {
    showStatus("warn", `local admin token unavailable: ${error.message}; mutating actions are disabled`);
  });
}
