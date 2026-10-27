/**
 * 把 WebUI 面板打成一个浏览器 bundle。
 *
 * 面板源码只 `import type` 框架类型，运行时不依赖 `cortico/*`，所以这里用 esbuild 直接打。
 * 产物路径写进 package.json 的 `cortico.webUiClient`。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = resolve(root, 'dist/webui.js');

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/webui/client.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  logLevel: 'info',
  // 浏览器侧只允许类型导入；把框架包标记为外部，真出现运行时导入会在加载时报错，而不是悄悄打进来。
  external: ['cortico', 'cortico/*'],
});

console.log(`wrote ${outFile}`);
