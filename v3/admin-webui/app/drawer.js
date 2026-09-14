// RCC V3 Admin WebUI — detail drawer with focus trap and close animation.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/drawer.js)

let lastPanelTrigger = null;

function panelTransitionMs(name, fallback) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function openPanel() {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  if (!drawer) return;
  lastPanelTrigger = document.activeElement;
  clearTimeout(drawer._closeTimer);
  drawer.classList.remove("is-closing");
  drawer.classList.add("is-open");
  backdrop?.classList.add("is-open");
  document.getElementById("drawer-close")?.focus();
}

export function closePanel() {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  if (!drawer || !drawer.classList.contains("is-open")) return;
  drawer.classList.remove("is-open");
  drawer.classList.add("is-closing");
  backdrop?.classList.remove("is-open");
  drawer._closeTimer = setTimeout(() => drawer.classList.remove("is-closing"), panelTransitionMs("--modal-close-dur", 150));
  if (lastPanelTrigger instanceof HTMLElement) lastPanelTrigger.focus();
  lastPanelTrigger = null;
}

export function wireDrawer({ onClose } = {}) {
  document.getElementById("drawer-close")?.addEventListener("click", closePanel);
  document.getElementById("drawer-cancel")?.addEventListener("click", () => {
    onClose?.();
    closePanel();
  });
  document.getElementById("drawer-backdrop")?.addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    const drawer = document.getElementById("drawer");
    if (!drawer || !drawer.classList.contains("is-open")) return;
    if (event.key === "Escape") {
      closePanel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...drawer.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
