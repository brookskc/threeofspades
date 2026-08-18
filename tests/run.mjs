// tests/run.mjs — headless regression tests for the DOM-free modules.
//   node tests/run.mjs
// Bootstraps a node_modules/three shim so `import 'three'` resolves to the
// vendored build, then hands off to suite.mjs (static imports are hoisted,
// so the shim has to be written before that module is loaded).
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shim = join(root, 'node_modules', 'three');
if (!existsSync(join(shim, 'three.module.js'))) {
  mkdirSync(shim, { recursive: true });
  copyFileSync(join(root, 'vendor', 'three.module.js'), join(shim, 'three.module.js'));
  writeFileSync(join(shim, 'package.json'), JSON.stringify({
    name: 'three', version: '0.170.0', type: 'module',
    main: 'three.module.js', exports: { '.': './three.module.js' },
  }, null, 2));
  console.log('(created node_modules/three shim from vendor/)');
}
const { run } = await import('./suite.mjs');
process.exit(await run());
