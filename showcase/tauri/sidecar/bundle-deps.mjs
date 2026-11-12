// Copies the packages the bundled sidecar needs at run time (bundle.sh keeps them external: native
// binaries and wasm can't be inlined) from node_modules into dist/node_modules, pruning what the
// local voice (Kokoro) never uses: other platforms' onnxruntime binaries and the CUDA/TensorRT
// providers, which the CPU path doesn't load.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'node_modules'), DST = path.join(HERE, 'dist', 'node_modules');
const require = createRequire(import.meta.url);
if (!existsSync(SRC)) { console.error('node_modules missing: run npm ci first.'); process.exit(1); }

// kokoro-js (TTS) pulls the rest in; phonemizer is kokoro-js's other dependency.
const ROOTS = ['kokoro-js', 'phonemizer'];
// transformers' node build only uses onnxruntime-node; the web build is never imported.
const SKIP = new Set(['onnxruntime-web']);

const deps = (name) => {
  try { return Object.keys(require(path.join(SRC, name, 'package.json')).dependencies ?? {}); }
  catch { return []; }
};
// resolve(name) → SRC/name or a nested node_modules (not expected with npm's flat layout, but safe).
const resolve = (name) => path.join(SRC, name);

function copyDep(name) {
  if (SKIP.has(name)) return;
  const src = resolve(name);
  if (!existsSync(src)) return; // an optional or already-skipped dependency
  const dst = path.join(DST, name);
  cpSync(src, dst, { recursive: true });
  // onnxruntime-node ships every platform's binaries; keep this platform's and drop the GPU providers.
  if (name === 'onnxruntime-node') {
    const bin = path.join(dst, 'bin', 'napi-v6');
    if (existsSync(bin)) {
      for (const p of readdirSync(bin)) {
        if (p === process.platform) continue;
        rmSync(path.join(bin, p), { recursive: true, force: true });
      }
      // Keep this machine's architecture only; drop the GPU providers (CPU inference never loads them).
      const plat = path.join(bin, process.platform);
      for (const p of readdirSync(plat)) {
        if (p !== String(process.arch)) rmSync(path.join(plat, p), { recursive: true, force: true });
      }
      for (const p of readdirSync(path.join(plat, String(process.arch)))) {
        if (/providers_(cuda|tensorrt)/.test(p)) rmSync(path.join(plat, String(process.arch), p), { force: true });
      }
    }
  }
  for (const d of deps(name)) copyDep(d);
}

mkdirSync(DST, { recursive: true });
for (const r of ROOTS) copyDep(r);
let bytes = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : bytes += statSync(p).size; } };
walk(DST);
console.log(`copied voice runtime deps: ${(bytes / 1e6).toFixed(0)} MB`);
