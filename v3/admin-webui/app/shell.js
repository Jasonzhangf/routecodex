// RCC V3 Admin WebUI — sidebar shell shared by every page.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/shell.js)

import { el, reload } from "./core.js";

const NAV_ITEMS = [
  ["/", "dashboard", "Dashboard", "Monitoring overview for ports, providers and traffic"],
  ["/requests.html", "usage", "Usage", "Request records, tokens, cache hit rate and errors"],
  ["/providers.html", "providers", "Providers", "Provider inventory, health and references"],
  ["/routes.html", "routes", "Routes", "Routing tiers, pools and weights"],
];

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
}
