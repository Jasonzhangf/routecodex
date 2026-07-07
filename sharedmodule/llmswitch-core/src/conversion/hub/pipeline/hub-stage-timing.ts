import { METADATA_CENTER_SYMBOL } from "../metadata-center-runtime-control-writer.js";

// feature_id: hub.stage_timing_observation
// Simplified diagnostic shell - timing state tracking removed for rustification

export type HubStageTimingPhase = "start" | "completed" | "error";

export type HubStageTopSummaryEntry = {
  stage: string;
  totalMs: number;
  count: number;
  avgMs: number;
  maxMs: number;
};

var _timings = new Map();
var _breakdowns = new Map();

function resolveStageElapsedMs(phase, details) {
  if (phase !== "completed" && phase !== "error") return undefined;
  if (typeof details?.elapsedMs === "number") return details.elapsedMs;
  if (typeof details?.nativeMs === "number") return details.nativeMs;
  return undefined;
}

export function isHubStageTimingDetailEnabled() {
  var raw = process.env.ROUTECODEX_STAGE_TIMING_DETAIL || process.env.RCC_STAGE_TIMING_DETAIL ||
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL || process.env.RCC_HUB_STAGE_TIMING_DETAIL;
  if (raw === undefined) return false;
  var n = String(raw).trim().toLowerCase();
  return n === "1" || n === "true" || n === "yes" || n === "on";
}

export function clearHubStageTiming(requestId) {
  if (!requestId) return;
  _timings.delete(requestId);
  _breakdowns.delete(requestId);
}

export function peekHubStageTopSummary(requestId, options) {
  if (!requestId) return [];
  var bd = _breakdowns.get(requestId);
  if (!bd || !bd.size) return [];
  var topN = options?.topN || 5;
  var minMs = (options?.minMs !== undefined && options?.minMs !== null) ? options.minMs : 5;
  var result = [];
  for (var entry of bd.entries()) {
    var stage = entry[0];
    var stats = entry[1];
    var totalMs = Math.max(0, Math.round(stats.totalMs));
    var count = Math.max(0, Math.floor(stats.count));
    var maxMs = Math.max(0, Math.round(stats.maxMs));
    var avgMs = count > 0 ? Math.max(0, Math.round(totalMs / count)) : 0;
    if (totalMs >= minMs) result.push({ stage: stage, totalMs: totalMs, count: count, avgMs: avgMs, maxMs: maxMs });
  }
  result.sort(function(a,b){return b.totalMs - a.totalMs;});
  return result.slice(0, topN);
}

export function attachHubStageTopSummary(args) {
  // noop - timing summary feature not needed in simplified shell
}

export function logHubStageTiming(requestId, stage, phase, details?) {
  var elapsedMs = resolveStageElapsedMs(phase, details);
  if (requestId && stage && typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    var bd = _breakdowns.get(requestId);
    if (!bd) { bd = new Map(); _breakdowns.set(requestId, bd); }
    var st = bd.get(stage);
    if (!st) { bd.set(stage, { totalMs: elapsedMs, count: 1, maxMs: elapsedMs }); }
    else { st.totalMs += elapsedMs; st.count += 1; st.maxMs = Math.max(st.maxMs, elapsedMs); }
  }
  var enabled = process.env.ROUTECODEX_STAGE_TIMING || process.env.RCC_STAGE_TIMING ||
    process.env.ROUTECODEX_HUB_STAGE_TIMING || process.env.RCC_HUB_STAGE_TIMING;
  if (enabled === undefined || !requestId || !stage) return;
  var normalized = String(enabled).trim().toLowerCase();
  if (normalized !== "1" && normalized !== "true" && normalized !== "yes" && normalized !== "on") return;
  var line = "[hub.detail][" + requestId + "] " + stage + "." + phase;
  if (details && Object.keys(details).length > 0) {
    try { line += " " + JSON.stringify(details); } catch(e) {}
  }
  if (phase === "error") { console.error(line); return; }
  console.log(line);
}

export function pruneTimingState(nowMs) {
  var ttl = 30 * 60 * 1000;
  var max = 4096;
  for (var key of _timings.keys()) {
    var tl = _timings.get(key);
    if (nowMs - tl.lastAtMs >= ttl) { _timings.delete(key); _breakdowns.delete(key); }
  }
  while (_timings.size > max) {
    var oldest = _timings.keys().next().value;
    if (!oldest) break;
    _timings.delete(oldest);
    _breakdowns.delete(oldest);
  }
}