import fs from 'node:fs';
import path from 'node:path';

type HotspotRow = Record<string, string>;

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function readHotspotRows(): HotspotRow[] {
  const inventoryPath = path.join(process.cwd(), 'docs/design/payload-copy-hotspot-inventory.md');
  const source = fs.readFileSync(inventoryPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.startsWith('| Area |'));
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  const headers = splitMarkdownRow(lines[headerIndex]);
  expect(headers).toEqual([
    'Area',
    'Class / lifecycle',
    'File / owner',
    'Current state',
    'Required action',
    'Release / gate evidence',
    'Status',
  ]);
  const rows: HotspotRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    const cells = splitMarkdownRow(line);
    expect(cells).toHaveLength(headers.length);
    rows.push(
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    );
  }
  return rows;
}

describe('payload copy hotspot inventory', () => {
  it('classifies every hotspot with lifecycle, release evidence, gate, owner, and status', () => {
    const rows = readHotspotRows();
    expect(rows.length).toBeGreaterThanOrEqual(15);

    for (const row of rows) {
      for (const column of [
        'Area',
        'Class / lifecycle',
        'File / owner',
        'Current state',
        'Required action',
        'Release / gate evidence',
        'Status',
      ]) {
        expect(row[column]).toBeTruthy();
        expect(row[column]).not.toMatch(/\b(?:TBD|unknown|unclassified)\b/i);
      }
      expect(row['File / owner']).toMatch(/`[^`]+`|[a-z0-9_.-]+\.[a-z0-9_.-]+/i);
      expect(row['Release / gate evidence']).toMatch(/\bGates?:/);
      expect(row.Status).toMatch(/^(?:done|partial|open): /);
    }
  });

  it('keeps all objective-required lifecycle areas represented', () => {
    const inventoryText = readHotspotRows()
      .map((row) => `${row.Area} ${row['Class / lifecycle']} ${row['File / owner']}`)
      .join('\n');

    for (const required of [
      /JS\/Rust boundary/i,
      /Retry first attempt/i,
      /Req inbound Responses context/i,
      /Hub request stage clones/i,
      /Server handler\/executor residency/i,
      /Hub response typed-node clones/i,
      /StreamPipe effect/i,
      /RuntimeStateWrite effect/i,
      /Response outbound effect materializer/i,
      /Request-stage result builders/i,
      /Responses reasoning registry consume/i,
      /Responses continuation store/i,
      /Snapshot recorder/i,
      /Errorsample writer/i,
      /Error\/contract observations/i,
    ]) {
      expect(inventoryText).toMatch(required);
    }
  });
});
