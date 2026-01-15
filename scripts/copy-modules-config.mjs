#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

async function copyModulesConfig() {
  const root = process.cwd();
  const srcModulesConfig = path.join(root, 'config', 'modules.json');
  const distModulesConfig = path.join(root, 'dist', 'config', 'modules.json');
  const srcDaemonAdminUi = path.join(root, 'docs', 'daemon-admin-ui.html');
  const distDaemonAdminUi = path.join(root, 'dist', 'docs', 'daemon-admin-ui.html');

  try {
    // 确保源文件存在
    await fs.access(srcModulesConfig);

    // 确保目标目录存在
    await fs.mkdir(path.dirname(distModulesConfig), { recursive: true });

    // 复制文件
    await fs.copyFile(srcModulesConfig, distModulesConfig);

    console.log('[copy-modules-config] copied modules.json to dist/config/modules.json');

    try {
      await fs.access(srcDaemonAdminUi);
      await fs.mkdir(path.dirname(distDaemonAdminUi), { recursive: true });
      await fs.copyFile(srcDaemonAdminUi, distDaemonAdminUi);
      console.log('[copy-modules-config] copied daemon-admin-ui.html to dist/docs/daemon-admin-ui.html');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn('[copy-modules-config] docs/daemon-admin-ui.html not found, skipping');
      } else {
        console.error('[copy-modules-config] failed to copy daemon admin ui:', error.message);
        process.exit(1);
      }
    }
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
