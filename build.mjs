/**
 * build.mjs
 *
 * Zero-dependency Node v24 build script that strips TypeScript types
 * (using Node's `module.stripTypeScriptTypes` from 'node:module')
 * and bundles LevelData.ts, GraphicsFactory.ts, SoundEngine.ts,
 * KiiLedgerService.ts, ExcaliburGameController.ts, and main.ts
 * into a single browser-ready IIFE bundle: `dist/bundle.js`.
 *
 * Usage:
 *   node build.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Determine TypeScript type stripper (Node v24 built-in or clean fallback)
let stripTypes = nodeModule.stripTypeScriptTypes;
if (typeof stripTypes !== 'function') {
  // Graceful fallback stripper for environments without module.stripTypeScriptTypes
  stripTypes = function (sourceCode) {
    return sourceCode
      .replace(/import\s+type\s+[^;]+;/g, '')
      .replace(/export\s+type\s+[^;]+;/g, '')
      .replace(/export\s+interface\s+[\s\S]*?\n\}/g, '')
      .replace(/interface\s+[\s\S]*?\n\}/g, '')
      .replace(/:\s*[A-Z][a-zA-Z0-9_<>\[\]|&\s]*(?=[=,\)\{\n;])/g, '')
      .replace(/\s+as\s+[a-zA-Z0-9_<>[\]|&]+/g, '');
  };
}

// 2. Ordered list of source files to bundle
const SOURCE_FILES = [
  'src/scenes/LevelData.ts',
  'src/scenes/ArenaGenerator.ts',
  'src/actors/DwarfSpriteMeta.ts',
  'src/actors/FallingObjectSpriteMeta.ts',
  'src/actors/BlockSpriteMeta.ts',
  'src/actors/GraphicsFactory.ts',
  'src/audio/SoundEngine.ts',
  'src/kii/KiiLedgerService.ts',
  'src/scenes/BossSpriteMeta.ts',
  'src/scenes/BossFight.ts',
  'src/scenes/ExcaliburGameController.ts',
  'src/input/GamepadInput.ts',
  'src/main.ts'
];

/**
 * Transforms ES module syntax (import / export) into micro-module registry format
 */
function transformToCommonJS(code) {
  let transformed = code;

  // 1. Remove pure type-only imports and exports that might remain
  transformed = transformed.replace(/^import\s+type\s+[\s\S]*?;/gm, '');
  transformed = transformed.replace(/^export\s+type\s+[\s\S]*?;/gm, '');
  transformed = transformed.replace(/^export\s+interface\s+[\s\S]*?^\}/gm, '');

  // 2. Named imports: import { A, B as C } from './path.ts'; -> const { A, B: C } = require('./path.ts');
  transformed = transformed.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, specifiers, importPath) => {
      const parts = specifiers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          if (s.includes(' as ')) {
            const [orig, alias] = s.split(/\s+as\s+/);
            return `${orig.trim()}: ${alias.trim()}`;
          }
          return s;
        });
      if (parts.length === 0) return '';
      return `const { ${parts.join(', ')} } = require('${importPath}');`;
    }
  );

  // 3. Namespace imports: import * as X from '...' -> const X = require('...');
  transformed = transformed.replace(
    /import\s*\*\s*as\s+([a-zA-Z0-9_$]+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");'
  );

  // 4. Default imports: import X from '...' -> const X = require('...').default || require('...');
  transformed = transformed.replace(
    /import\s+([a-zA-Z0-9_$]+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2").default || require("$2");'
  );

  // 5. Named exports of declarations:
  // export const X = ... -> const X = exports.X = ...
  transformed = transformed.replace(/^export\s+const\s+([a-zA-Z0-9_$]+)\s*=/gm, 'const $1 = exports.$1 =');
  transformed = transformed.replace(/^export\s+let\s+([a-zA-Z0-9_$]+)\s*=/gm, 'let $1 = exports.$1 =');

  // export function X(...) { ... } -> function X(...) { ... }; exports.X = X;
  transformed = transformed.replace(/^export\s+function\s+([a-zA-Z0-9_$]+)\s*\(/gm, 'function $1(');
  transformed = transformed.replace(/^export\s+async\s+function\s+([a-zA-Z0-9_$]+)\s*\(/gm, 'async function $1(');

  // export class X { ... } -> class X { ... }; exports.X = X;
  transformed = transformed.replace(/^export\s+class\s+([a-zA-Z0-9_$]+)/gm, 'class $1');

  // Collect exported function / class names from the file and export them at the bottom
  const functionMatches = [...code.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g)];
  for (const m of functionMatches) {
    transformed += `\nexports.${m[1]} = ${m[1]};`;
  }

  const classMatches = [...code.matchAll(/export\s+class\s+([a-zA-Z0-9_$]+)/g)];
  for (const m of classMatches) {
    transformed += `\nexports.${m[1]} = ${m[1]};`;
  }

  // 6. Named export list: export { A, B as C }; -> Object.assign(exports, { A, C: B });
  transformed = transformed.replace(/export\s*\{([\s\S]*?)\}\s*;?/g, (_, specifiers) => {
    const pairs = specifiers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.includes(' as ')) {
          const [orig, alias] = s.split(/\s+as\s+/);
          return `${alias.trim()}: ${orig.trim()}`;
        }
        return s;
      });
    if (pairs.length === 0) return '';
    return `Object.assign(exports, { ${pairs.join(', ')} });`;
  });

  // 7. export default
  transformed = transformed.replace(/^export\s+default\s+/gm, 'exports.default = ');

  return transformed;
}

export function buildBundle() {
  console.log('⛏️ [Dwarf KII Platformer] Starting zero-dependency bundle build...');

  const modulesData = [];

  for (const relPath of SOURCE_FILES) {
    const fullPath = path.resolve(__dirname, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Source file not found: ${fullPath}`);
    }

    const rawTs = fs.readFileSync(fullPath, 'utf8');
    const stripped = stripTypes(rawTs);
    const transformed = transformToCommonJS(stripped);

    modulesData.push({
      id: relPath,
      code: transformed
    });
    console.log(`  ✓ Stripped & transformed: ${relPath}`);
  }

  // Bundle into an IIFE with micro-module loader
  const bundleContent = `/**
 * Dwarf KII Platformer - Browser Bundle
 * Generated by build.mjs (Zero-dependency Node v24 TypeScript Bundler)
 * Murderface Records & KII Blockchain
 */
(function () {
  "use strict";

  var __modules = {};

  function __define(id, factory) {
    __modules[id] = { factory: factory, exports: null };
  }

  function __resolve(callerId, reqPath) {
    // Exact match
    if (__modules[reqPath]) return reqPath;

    // Normalize path relative to caller or base
    var clean = reqPath.replace(/^[./]+/, '').replace(/\\.ts$/, '');
    for (var key in __modules) {
      var keyClean = key.replace(/^[./]+/, '').replace(/\\.ts$/, '');
      if (keyClean.endsWith(clean) || key.indexOf(clean) !== -1) {
        return key;
      }
    }
    return reqPath;
  }

  function __require(callerId, id) {
    var resolvedId = __resolve(callerId, id);
    var mod = __modules[resolvedId];
    if (!mod) {
      // Fallback: search by filename basename
      var base = id.split('/').pop().replace(/\\.ts$/, '');
      for (var k in __modules) {
        if (k.indexOf(base) !== -1) {
          mod = __modules[k];
          break;
        }
      }
    }
    if (!mod) {
      console.warn("Module not found in bundle: " + id + " (called from " + callerId + ")");
      return {};
    }
    if (!mod.exports) {
      mod.exports = {};
      mod.factory(
        { exports: mod.exports },
        mod.exports,
        function (dep) { return __require(resolvedId, dep); }
      );
    }
    return mod.exports;
  }

  // --- Module Definitions ---
${modulesData
  .map(
    (m) => `  __define(${JSON.stringify(m.id)}, function (module, exports, require) {
${m.code
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
  });`
  )
  .join('\n\n')}

  // --- Execute Entry Point ---
  __require("", "src/main.ts");
})();
`;

  const distDir = path.resolve(__dirname, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const outPath = path.resolve(distDir, 'bundle.js');
  fs.writeFileSync(outPath, bundleContent, 'utf8');

  console.log(`🎉 [Dwarf KII Platformer] Successfully bundled to: ${outPath} (${(bundleContent.length / 1024).toFixed(1)} KB)`);
}

// Auto-run when executed directly via node build.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  buildBundle();
}
