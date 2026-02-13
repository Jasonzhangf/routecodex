#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((resolveInput, rejectInput) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveInput(data));
    process.stdin.on('error', rejectInput);
  });
}

class DeepSeekHash {
  constructor() {
    this.wasmInstance = null;
    this.offset = 0;
    this.cachedUint8Memory = null;
    this.cachedTextEncoder = new TextEncoder();
  }

  getCachedUint8Memory() {
    if (this.cachedUint8Memory === null || this.cachedUint8Memory.byteLength === 0) {
      this.cachedUint8Memory = new Uint8Array(this.wasmInstance.memory.buffer);
    }
    return this.cachedUint8Memory;
  }

  encodeString(text, allocate, reallocate) {
    if (!reallocate) {
      const encoded = this.cachedTextEncoder.encode(text);
      const ptr = allocate(encoded.length, 1) >>> 0;
      const memory = this.getCachedUint8Memory();
      memory.subarray(ptr, ptr + encoded.length).set(encoded);
      this.offset = encoded.length;
      return ptr;
    }

    const strLength = text.length;
    let ptr = allocate(strLength, 1) >>> 0;
    const memory = this.getCachedUint8Memory();
    let asciiLength = 0;

    for (; asciiLength < strLength; asciiLength += 1) {
      const charCode = text.charCodeAt(asciiLength);
      if (charCode > 127) {
        break;
      }
      memory[ptr + asciiLength] = charCode;
    }

    if (asciiLength !== strLength) {
      if (asciiLength > 0) {
        text = text.slice(asciiLength);
      }
      ptr = reallocate(ptr, strLength, asciiLength + text.length * 3, 1) >>> 0;
      const result = this.cachedTextEncoder.encodeInto(
        text,
        this.getCachedUint8Memory().subarray(ptr + asciiLength, ptr + asciiLength + text.length * 3)
      );
      asciiLength += result.written;
      ptr = reallocate(ptr, asciiLength + text.length * 3, asciiLength, 1) >>> 0;
    }

    this.offset = asciiLength;
    return ptr;
  }

  async init(wasmPath) {
    const wasmBuffer = await readFile(wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    this.wasmInstance = instance.exports;
  }

  solve(algorithm, challenge, salt, difficulty, expireAt) {
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const prefix = `${salt}_${expireAt}_`;
    const retptr = this.wasmInstance.__wbindgen_add_to_stack_pointer(-16);

    try {
      const ptr0 = this.encodeString(
        challenge,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1
      );
      const len0 = this.offset;

      const ptr1 = this.encodeString(
        prefix,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1
      );
      const len1 = this.offset;

      this.wasmInstance.wasm_solve(retptr, ptr0, len0, ptr1, len1, Number(difficulty));

      const dataView = new DataView(this.wasmInstance.memory.buffer);
      const status = dataView.getInt32(retptr + 0, true);
      const value = dataView.getFloat64(retptr + 8, true);
      if (status === 0 || !Number.isFinite(value)) {
        return null;
      }
      return Math.trunc(value);
    } finally {
      this.wasmInstance.__wbindgen_add_to_stack_pointer(16);
    }
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw || !raw.trim()) {
    throw new Error('Missing stdin JSON payload');
  }

  const payload = JSON.parse(raw);
  const wasmPath = payload.wasmPath
    ? resolve(String(payload.wasmPath))
    : resolve(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm');

  const solver = new DeepSeekHash();
  await solver.init(wasmPath);
  const answer = solver.solve(
    payload.algorithm,
    payload.challenge,
    payload.salt,
    payload.difficulty,
    payload.expireAt
  );

  process.stdout.write(JSON.stringify({ ok: answer !== null, answer }) + '\n');
}

main().catch((error) => {
  process.stderr.write((error && error.stack) ? String(error.stack) : String(error) + '\n');
  process.exit(1);
});
