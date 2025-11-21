#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

async function copyModulesConfig() {
  const root = process.cwd();
  const srcModulesConfig = path.join(root, 'config', 'modules.json');
  const distModulesConfig = path.join(root, 'dist', 'config', 'modules.json');

  try {
    // 确保源文件存在
    await fs.access(srcModulesConfig);

    // 确保目标目录存在
    await fs.mkdir(path.dirname(distModulesConfig), { recursive: true });

    // 复制文件
    await fs.copyFile(srcModulesConfig, distModulesConfig);

    console.log('[copy-modules-config] copied modules.json to dist/config/modules.json');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('[copy-modules-config] source modules.json not found, skipping');
    } else {
      console.error('[copy-modules-config] failed:', error.message);
      process.exit(1);
    }
  }
}

copyModulesConfig();