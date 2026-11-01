import { readFileSync } from 'node:fs';

export function frame(event, data) {
  const rawData = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${rawData}\n\n`;
}

export const fixturePath = (name) => new URL(`../../../fixtures/protocol-live-mock-matrix/cases/${name}`, import.meta.url);

export function rawSseText(events) {
  return events.map((entry) => {
    const lines = [];
    if (entry.event !== undefined) lines.push(`event: ${entry.event}`);
    lines.push(`data: ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}`);
    return `${lines.join('\n')}\n\n`;
  }).join('');
}

export function sseFrame(event, data) {
  return { event, data };
}

export function loadSseFixture(name) {
  const fixture = JSON.parse(readFileSync(fixturePath(name), 'utf8'));
  return {
    raw: rawSseText(fixture.upstream_response.sse_events),
    expected: fixture.expected_client,
  };
}
