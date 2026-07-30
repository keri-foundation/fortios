#!/usr/bin/env node

/**
 * Dedicated producer-to-consumer interoperability proof.
 *
 * Requires the FortWeb sibling checkout. Fails (exit 1) if unavailable.
 *
 * Usage:
 *   node tools/runtime-package-interop.mjs [--fortweb <path>]
 *
 * npm script:
 *   npm run test:runtime-package-interop
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const IMPORT_SCRIPT = path.join(REPO_ROOT, 'tools', 'import-fortweb-runtime-package.mjs');

function fail(msg) {
  process.stderr.write(`INTEROP FAIL: ${msg}\n`);
  process.exit(1);
}

async function main() {
  // Resolve FortWeb path
  const fortwebArg = process.argv.indexOf('--fortweb');
  const fortwebDir = fortwebArg >= 0
    ? path.resolve(process.argv[fortwebArg + 1])
    : path.join(REPO_ROOT, '..', 'fortweb');

  const packagerScript = path.join(fortwebDir, 'tools', 'package-runtime.mjs');
  try {
    await stat(packagerScript);
  } catch {
    fail(`FortWeb packager not found at ${packagerScript}. Use --fortweb <path> or ensure sibling checkout exists.`);
  }

  // Create temporary work directories
  const workDir = path.join(tmpdir(), `fortweb-interop-${Date.now()}`);
  const runtimeDir = path.join(workDir, 'dist', 'runtime');
  const outDir = path.join(workDir, 'out');
  const importDest = path.join(workDir, 'imported');

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // Create minimal runtime fixture
  const fixtureFiles = {
    'app/index.html': '<!DOCTYPE html>\n<html><body><p>Interop \xe2\x82\xac\u00a7</p>\n</body></html>\n',
    'app/app/main.js': 'console.log("interop-proof");\n',
    'vendor/data.bin': Buffer.from([0x00, 0xFF, 0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00]),
  };

  for (const [relPath, content] of Object.entries(fixtureFiles)) {
    const fullPath = path.join(runtimeDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Temporarily swap FortWeb dist/runtime
  const fortwebDist = path.join(fortwebDir, 'dist', 'runtime');
  const fortwebDistBak = fortwebDist + '.interop-bak';
  let distWasSwapped = false;

  try {
    try { await (await import('node:fs/promises')).rename(fortwebDist, fortwebDistBak); } catch { /* no existing */ }
    await symlink(runtimeDir, fortwebDist);
    distWasSwapped = true;
  } catch (e) {
    // Clean up and fail
    try { await (await import('node:fs/promises')).rename(fortwebDistBak, fortwebDist); } catch { /* */ }
    fail(`Cannot set up FortWeb fixture: ${e.message}`);
  }

  let zipPath;
  try {
    // Generate ZIP
    console.log('Generating FortWeb runtime package...');
    execFileSync('node', [packagerScript, '--no-build', '--out-dir', outDir], {
      cwd: fortwebDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entries = await readdir(outDir);
    const zipName = entries.find(e => e.endsWith('.zip'));
    if (!zipName) fail('No ZIP produced by FortWeb packager');
    zipPath = path.join(outDir, zipName);
  } finally {
    // Restore original dist/runtime
    if (distWasSwapped) {
      try { await (await import('node:fs/promises')).unlink(fortwebDist); } catch { /* */ }
      try { await (await import('node:fs/promises')).rename(fortwebDistBak, fortwebDist); } catch { /* */ }
    }
  }

  // Compute ZIP digest
  const zipBuffer = readFileSync(zipPath);
  const zipDigest = createHash('sha256').update(zipBuffer).digest('hex');
  console.log(`ZIP: ${zipPath}\nSHA-256: ${zipDigest}`);

  // Import with Fort-ios importer
  console.log('Importing with Fort-ios importer...');
  const { stderr } = execFileSync('node', [IMPORT_SCRIPT, zipPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORTWEB_IMPORT_DEST: importDest },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (stderr) process.stderr.write(stderr);

  // Verify imported structure
  const verify = async () => {
    // Manifest exists and is valid
    const manifestPath = path.join(importDest, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.package_name !== 'fortweb-runtime') fail(`package_name: ${manifest.package_name}`);
    if (manifest.producer !== 'fortweb') fail(`producer: ${manifest.producer}`);
    if (manifest.entrypoint !== 'app/index.html') fail(`entrypoint: ${manifest.entrypoint}`);

    // Entrypoint file exists
    const entryPath = path.join(importDest, 'app', 'index.html');
    try { await stat(entryPath); } catch { fail('entrypoint app/index.html missing after import'); }

    // Wrapper redirect resolves to entrypoint
    const redirectHtml = await readFile(path.join(importDest, 'index.html'), 'utf8');
    if (!redirectHtml.includes('./app/index.html')) fail('redirect does not point to ./app/index.html');

    // All manifest-listed files present with correct hashes
    let verified = 0;
    for (const f of manifest.files) {
      const fp = path.join(importDest, f.path);
      const buf = readFileSync(fp);
      const hash = createHash('sha256').update(buf).digest('hex');
      if (hash !== f.sha256) fail(`hash mismatch: ${f.path}`);
      if (buf.length !== f.bytes) fail(`size mismatch: ${f.path} expected ${f.bytes} got ${buf.length}`);
      verified++;
    }

    console.log(`Verified: ${verified} files, ${manifest.files.length} in manifest`);
    console.log(`Entrypoint: app/index.html`);
    console.log(`Redirect: ./app/index.html`);
  };

  await verify();

  // Cleanup
  rmSync(workDir, { recursive: true, force: true });
  console.log('INTEROP PASS');
}

main().catch(err => {
  process.stderr.write(`INTEROP ERROR: ${err.message}\n`);
  process.exit(1);
});
