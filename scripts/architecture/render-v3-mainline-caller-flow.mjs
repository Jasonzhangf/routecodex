#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  renderV3MainlineCallerFlowHtml,
  renderV3MainlineCallerFlowMarkdown,
  V3_CALLER_FLOW_HTML_PATH,
  V3_CALLER_FLOW_PATH,
} from './v3-mainline-caller-flow-lib.mjs';

const root = process.cwd();
const output = renderV3MainlineCallerFlowMarkdown(root);
const outputPath = path.join(root, V3_CALLER_FLOW_PATH);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf8');
const htmlOutput = renderV3MainlineCallerFlowHtml(root);
const htmlOutputPath = path.join(root, V3_CALLER_FLOW_HTML_PATH);
fs.mkdirSync(path.dirname(htmlOutputPath), { recursive: true });
fs.writeFileSync(htmlOutputPath, htmlOutput, 'utf8');
console.log('[render:v3-mainline-caller-flow] ok');
console.log(`- wrote ${V3_CALLER_FLOW_PATH}`);
console.log(`- wrote ${V3_CALLER_FLOW_HTML_PATH}`);
