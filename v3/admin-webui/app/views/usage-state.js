// RCC V3 Admin WebUI — Usage (Requests) view state.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-state.js)
//
// Kept in its own module so the view, the filter rail and the export helpers can
// all read the same store without importing each other.

export const state = {
  records: [],
  attemptRecords: [],
  errorFacets: [],
  page: 1,
  pageSize: 100,
  total: 0,
  attemptsTotal: 0,
  attemptsPage: 1,
  errorStatuses: 0,
  errorExamples: {},
  tab: "entries",
  entriesGroup: "pool",
  stats: {},
  timeseries: [],
  facets: { ports: {}, providers: {}, models: {}, routes: {}, endpoints: {}, sessions: {}, response_types: {}, error_status_codes: {} },
  // The rail's value list must not come from `facets`: the server narrows
  // facets to whatever the current filter selected, so filtering to one
  // provider would delete the other providers from the rail and the user
  // could never re-check them. This snapshot is taken from an unfiltered
  // query instead, and only ever grows.
  railFacets: null,
  // Values already offered to the user per layer, so auto-seeding can tell a
  // genuinely new provider from one the user deliberately unchecked.
  knownLayerValues: {},
  errorStatusCode: null,
  selected: null,
  tableWidths: { entries: null, attempts: null, errors: null },
  loading: false,
  // Filter model: whitelist-by-default, opt-out to hide. See usage-filters.js
  // for the OR-within-layer / AND-across-layer rules.
  port: "all",
  sortMode: "time",
  statusInclude: null,        // null = "not yet seeded"; replaced by Set of kind keys
  providerInclude: null,      // null = "not yet seeded"; replaced by Set of provider names
  modelInclude: null,         // null = "not yet seeded"; replaced by Set of model names
  errorCodeInclude: null,     // null = "not yet seeded"; replaced by Set of status-code strings
  collapsed: new Set(),
  selection: new Set(),
  kindCounts: {},
  providerCounts: {},
  modelCounts: {},
  errorCodeCounts: {},
  exports: [],
};

// The panel/rail modules need to trigger a reload or a selection repaint, but
// the loader and the selection bar are owned by the view and the export module.
// Registering them here keeps those modules free of a circular import back into
// the view, which would otherwise depend on ESM evaluation order.
export const hooks = { loadRecords: () => {}, renderSelection: () => {} };
