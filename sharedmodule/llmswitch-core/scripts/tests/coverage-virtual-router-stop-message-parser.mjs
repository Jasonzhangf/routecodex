#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const parserModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'routing-stop-message-parser.js')
).href;

function setEnvVar(key, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

async function importParser(tag) {
  return import(`${parserModuleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function withTempNativeModule(content, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopmessage-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await run(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  delete process.env.ROUTECODEX_USER_DIR;

  try {
    {
      const mod = await importParser('baseline');
      const parseStopMessageInstruction = mod.parseStopMessageInstruction;
      assert.equal(typeof parseStopMessageInstruction, 'function');

      assert.equal(parseStopMessageInstruction(''), null);
      assert.equal(parseStopMessageInstruction('stopMessage'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:,,,'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:on,10'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:ai=on'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:mode auto=ai'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:"unterminated'), null);
      assert.equal(parseStopMessageInstruction('stopMessage:"",2'), null);

      const clear = parseStopMessageInstruction('stopMessage:clear');
      assert.deepEqual(clear, { type: 'stopMessageClear' });

      const quoted = parseStopMessageInstruction('stopMessage:"继续执行",3,ai:on');
      assert.equal(quoted?.type, 'stopMessageSet');
      assert.equal(quoted?.stopMessageText, '继续执行');
      assert.equal(quoted?.stopMessageMaxRepeats, 3);
      assert.equal(quoted?.stopMessageAiMode, 'on');

      const modeOff = parseStopMessageInstruction('stopMessage:"继续执行",mode auto=off,9');
      assert.equal(modeOff?.type, 'stopMessageSet');
      assert.equal(modeOff?.stopMessageMaxRepeats, 9);
      assert.equal(modeOff?.stopMessageAiMode, 'off');

      const modeOn = parseStopMessageInstruction('stopMessage:"继续执行",mode auto=ai,7');
      assert.equal(modeOn?.type, 'stopMessageSet');
      assert.equal(modeOn?.stopMessageMaxRepeats, 7);
      assert.equal(modeOn?.stopMessageAiMode, 'on');

      const unquoted = parseStopMessageInstruction('stopMessage:继续执行,8,ai:off');
      assert.equal(unquoted?.type, 'stopMessageSet');
      assert.equal(unquoted?.stopMessageText, '继续执行');
      assert.equal(unquoted?.stopMessageMaxRepeats, 8);
      assert.equal(unquoted?.stopMessageAiMode, 'off');

      const escaped = parseStopMessageInstruction('stopMessage:"a\\\"b",4');
      assert.equal(escaped?.type, 'stopMessageSet');
      assert.equal(escaped?.stopMessageText, 'a"b');
      assert.equal(escaped?.stopMessageMaxRepeats, 4);

      const parseIntLike = parseStopMessageInstruction('stopMessage:"x",12abc');
      assert.equal(parseIntLike?.type, 'stopMessageSet');
      assert.equal(parseIntLike?.stopMessageMaxRepeats, 12);
    }

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return "null"; }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-null');
        assert.equal(mod.parseStopMessageInstruction('stopMessage:"x",2'), null);
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return JSON.stringify({ kind: "set", maxRepeats: 2 }); }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-invalid');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return JSON.stringify({ kind: "set", text: "default-repeat" }); }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-default-max-repeats');
        const parsed = mod.parseStopMessageInstruction('stopMessage:"x",2');
        assert.equal(parsed?.type, 'stopMessageSet');
        assert.equal(parsed?.stopMessageText, 'default-repeat');
        assert.equal(parsed?.stopMessageMaxRepeats, 10);
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return JSON.stringify({ kind: "set", text: "file://notes/stop.txt", maxRepeats: 2 }); }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        const tempUserDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopmessage-userdir-'));
        try {
          await fs.mkdir(path.join(tempUserDir, 'notes'), { recursive: true });
          await fs.writeFile(path.join(tempUserDir, 'notes', 'stop.txt'), 'from-file', 'utf8');
          setEnvVar('ROUTECODEX_USER_DIR', tempUserDir);
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const mod = await importParser('native-file-source');
          const parsed = mod.parseStopMessageInstruction('stopMessage:"x",2');
          assert.equal(parsed?.type, 'stopMessageSet');
          assert.equal(parsed?.stopMessageText, 'from-file');
          assert.equal(parsed?.stopMessageSource, 'explicit_file');
        } finally {
          await fs.rm(tempUserDir, { recursive: true, force: true });
          delete process.env.ROUTECODEX_USER_DIR;
        }
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return "{invalid-json"; }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-invalid-json');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        "  parseStopMessageInstructionJson() { throw 'string-failure'; }",
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-throw-string');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return "[]"; }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-array-payload');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return JSON.stringify({ kind: "noop" }); }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-kind-invalid');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      [
        'module.exports = {',
        '  parseStopMessageInstructionJson() { return { kind: "set", text: "x", maxRepeats: 2 }; }',
        '};'
      ].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-non-string');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      ['module.exports = {};'].join('\n'),
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importParser('native-missing-fn');
        assert.throws(
          () => mod.parseStopMessageInstruction('stopMessage:"x",2'),
          /virtual-router-native-hotpath|required but unavailable/i
        );
      }
    );

    console.log('✅ coverage-virtual-router-stop-message-parser passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
    if (prevUserDir === undefined) {
      delete process.env.ROUTECODEX_USER_DIR;
    } else {
      process.env.ROUTECODEX_USER_DIR = prevUserDir;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-stop-message-parser failed:', error);
  process.exit(1);
});
