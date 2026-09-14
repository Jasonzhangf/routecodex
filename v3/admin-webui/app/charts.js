// RCC V3 Admin WebUI — dependency-free donut and bar charts.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/charts.js)

import { el, fmtCompact } from "./core.js";

// Donut chart from [label, value] entries; center shows total and caption.
export function renderDonut(container, entries, caption = "") {
  container.replaceChildren();
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  const donut = el("div", "donut");
  donut.setAttribute("role", "img");
  donut.setAttribute("aria-label", `${caption} ${total.toLocaleString()}`);
  const ring = el("div", "donut-ring");
  ring.style.setProperty("--donut-empty", "conic-gradient(var(--amb-shade) 0 100%)");
  if (total > 0) {
    let cursor = 0;
    const stops = [];
    for (const [, value] of entries) {
      const share = (Number(value || 0) / total) * 100;
      if (share <= 0) continue;
      const next = Math.min(100, cursor + share);
      stops.push(`var(--donut-seg-${stops.length}) ${cursor}% ${next}%`);
      cursor = next;
    }
    if (stops.length) ring.style.setProperty("--donut-fill", `conic-gradient(${stops.join(", ")})`);
  }
  const center = el("div", "donut-center");
  center.appendChild(el("div", "donut-value", total.toLocaleString()));
  if (caption) center.appendChild(el("div", "donut-caption", caption));
  donut.appendChild(ring);
  donut.appendChild(center);
  container.appendChild(donut);
  const legend = el("div", "donut-legend");
  entries.forEach(([label, value], index) => {
    const item = el("div", "donut-item");
    item.appendChild(el("span", `donut-swatch seg-${index}`));
    item.appendChild(el("span", "donut-label", label));
    item.appendChild(el("span", "donut-count", Number(value || 0).toLocaleString()));
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

// Bar chart over timeseries buckets: one column per bucket, tallest at 80%.
export function renderBarChart(chart, buckets, metric, range) {
  chart.replaceChildren();
  if (!buckets.length) {
    chart.appendChild(el("div", "empty-chart muted", "no data in selected range"));
    return;
  }
  const chartHeight = Math.max(200, chart.clientHeight || 0);
  const axisHeight = 22;
  const gap = 8;
  const usableHeight = chartHeight - axisHeight - gap;
  const fillHeight = Math.max(20, Math.round(usableHeight * 0.8));
  const maximum = Math.max(...buckets.map((bucket) => Number(bucket[metric] || 0)), 1);

  const yAxis = el("div", "chart-y-axis");
  yAxis.style.height = `${chartHeight}px`;
  for (const ratio of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
    const axisValue = maximum * ratio;
    const label = el("span", "chart-y-label", metric === "cache_hit_rate_percent" ? `${axisValue.toFixed(0)}%` : fmtCompact(axisValue));
    label.style.bottom = `${Math.round(usableHeight * ratio)}px`;
    yAxis.appendChild(label);
  }
  const grid = el("div", "chart-gridlines");
  for (const ratio of [1, 0.8, 0.6, 0.4, 0.2]) {
    const line = el("i");
    line.style.bottom = `${Math.round(usableHeight * ratio)}px`;
    grid.appendChild(line);
  }

  const bars = el("div", "chart-bars");
  for (const bucket of buckets) {
    const value = Number(bucket[metric] || 0);
    const column = el("div", "bar-column");
    column.style.height = `${chartHeight}px`;
    const spacer = el("div", "bar-spacer");
    spacer.style.height = `${Math.max(0, usableHeight - fillHeight)}px`;
    const bar = el("div", "bar");
    const heightPx = Math.max(2, Math.round((value / maximum) * fillHeight));
    bar.style.height = `${heightPx}px`;
    const displayValue = metric === "cache_hit_rate_percent" ? `${value.toFixed(1)}%` : fmtCompact(value);
    bar.title = `${bucket.date}: ${displayValue} (${bucket.count.toLocaleString()} requests)`;
    const label = el("span", "axis", chartLabel(bucket, range));
    label.title = bucket.date;
    column.append(spacer, bar, label);
    bars.appendChild(column);
  }
  bars.appendChild(grid);
  chart.replaceChildren(yAxis, bars);
}

function chartLabel(bucket, range) {
  if (range === "today") return bucket.date.slice(11, 16);
  if (range === "month") return `${bucket.date.slice(5)} w`;
  return bucket.date.slice(5);
}
