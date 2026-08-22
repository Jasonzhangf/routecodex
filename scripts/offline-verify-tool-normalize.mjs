import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distRoot = path.resolve(__dirname, '..', 'dist');

const normalizerPath = path.join(distRoot, 'server', 'utils', 'tool-args-normalizer.js');
const { normalizeShellArgsJSON } = await import(normalizerPath);

function assertEqual(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) {
    console.error('ASSERT FAIL:', msg, '\nexpected:', b, '\nactual  :', a);
    process.exit(2);
  }
}

function parse(s) { try { return JSON.parse(s); } catch { return null; } }

const cases = [
  {
    name: 'string-with-pipe',
    in: JSON.stringify({ command: "find . -type f -not -path './.git/*' | sort | uniq -d -w 32" }),
    want: (o) => ({ command: ['bash', '-lc', "find . -type f -not -path './.git/*' | sort | uniq -d -w 32"], ...o }),
  },
  {
    name: 'argv-with-pipe-tokenized',
    in: JSON.stringify({ command: ['find', '.', '-type', 'f', '-not', '-path', "./.git/*", '|', 'sort', '|', 'uniq', '-d', '-w', '32'] }),
    want: (o) => ({ command: ['bash', '-lc', "find . -type f -not -path ./.git/* | sort | uniq -d -w 32"], ...o }),
  },
  {
    name: 'argv-no-meta',
    in: JSON.stringify({ command: ['find', '.', '-type', 'f'] }),
    want: (o) => ({ command: ['find', '.', '-type', 'f'], ...o }),
  }
];

for (const tc of cases) {
  const outStr = normalizeShellArgsJSON(tc.in) || tc.in; // if no change, use original
  const out = parse(outStr);
  const expected = tc.want({});
  // Relaxed compare for argv-no-meta (no change expected)
  if (tc.name === 'argv-no-meta') {
    assertEqual(out.command, expected.command, tc.name);
  } else {
    assertEqual(out.command[0], 'bash', tc.name+':bash');
    assertEqual(out.command[1], '-lc', tc.name+':-lc');
  }
  console.log('PASS:', tc.name, '=>', out.command);
}

console.log('All offline checks passed.');

