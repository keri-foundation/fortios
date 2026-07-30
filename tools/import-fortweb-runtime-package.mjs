#!/usr/bin/env node

/**
 * Byte-preserving FortWeb runtime package importer.
 *
 * Accepts one FortWeb runtime ZIP, validates archive structure and integrity,
 * and stages the verified package under WebPayload/ without modifying any
 * imported byte.
 *
 * Usage:
 *   node tools/import-fortweb-runtime-package.mjs <runtime-package.zip>
 *
 * Contract (from FortWeb runtime-package-manifest.mjs):
 *   - package_name:   fortweb-runtime
 *   - producer:       fortweb
 *   - payload_profile: offline-runtime
 *   - entrypoint:     app/index.html   (package-root-relative: fortweb-runtime/app/index.html)
 *   - manifest:       manifest.json
 *   - checksums:      checksums.sha256
 *   - schema:         schema_version (string)
 *   - file size:      bytes
 *
 * Path bases:
 *   package-root-relative: relative to fortweb-runtime/ inside the ZIP
 *   WebPayload-root-relative: relative to WebPayload/ after copyTree flattens the root
 *   The manifest entrypoint uses package-root-relative.
 *   The wrapper redirect uses WebPayload-root-relative (./app/index.html).
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, lstat, writeFile, symlink as fsSymlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';

// --- Configuration ---
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PAYLOAD_DEST = process.env.FORTWEB_IMPORT_DEST
  ? path.resolve(process.env.FORTWEB_IMPORT_DEST)
  : path.join(REPO_ROOT, 'WebPayload');
const EXPECTED_PACKAGE_NAME = 'fortweb-runtime';
const EXPECTED_PRODUCER = 'fortweb';
const EXPECTED_PROFILE = 'offline-runtime';
const ENTRY_DOCUMENT = 'app/index.html';
const MANIFEST_FILENAME = 'manifest.json';
const CHECKSUM_FILENAME = 'checksums.sha256';

// --- Helpers ---

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha256Buffer(buf) {
  const hash = createHash('sha256');
  hash.update(buf);
  return hash.digest('hex');
}

/**
 * Check whether a path is safe: no absolute, no backslash, no traversal, canonical.
 */
function isSafeRelative(p) {
  if (path.isAbsolute(p)) return false;
  if (p.includes('\\')) return false;
  const normalized = path.normalize(p);
  if (normalized !== p) return false;
  if (normalized.startsWith('..')) return false;
  // Embedded traversal after normalization still detectable
  const segments = normalized.split(path.sep);
  if (segments.includes('..')) return false;
  return true;
}

/**
 * Verify that resolvedPath stays within rootDir and does not pass through symlinks.
 */
async function isContained(rootDir, resolvedPath) {
  const rel = path.relative(rootDir, resolvedPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;

  // Walk each component and check for symlinks
  let current = rootDir;
  for (const seg of rel.split(path.sep)) {
    if (!seg || seg === '..') return false;
    current = path.join(current, seg);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink()) return false;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // not yet created
      throw e;
    }
  }
  return true;
}

// --- ZIP listing via system unzip ---

function listZipEntries(zipPath) {
  try {
    const out = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return parseUnzipList(out);
  } catch (e) {
    throw new Error(`Cannot list ZIP entries: ${e.message}`);
  }
}

function parseUnzipList(output) {
  // macOS unzip -l format:
  //   Length      Date    Time    Name
  //   --------  ---------- -----   ----
  //       1234  01-01-2026 00:00   path/to/file
  //   --------                     -------
  //    12345678                     100 files
  const entries = [];
  const lines = output.split('\n');
  let inEntries = false;
  for (const line of lines) {
    if (line.startsWith(' --------') || line.startsWith('---------')) {
      inEntries = !inEntries;
      continue;
    }
    if (!inEntries) continue;
    // Match: leading spaces, length (digits), spaces, date (dd-mm-yyyy), spaces, time (hh:mm), spaces, name
    const m = line.match(/^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
    if (m) {
      entries.push({ length: parseInt(m[1], 10), name: m[2].trim() });
    }
  }
  return entries;
}

// --- Validation ---

function validateZipEntries(entries, packageName) {
  const errors = [];
  const names = new Set();
  const normNames = new Set();

  const prefix = `${packageName}/`;
  let hasRoot = false;

  for (const e of entries) {
    const name = e.name;
    const norm = path.normalize(name);

    // Absolute paths
    if (path.isAbsolute(name)) {
      errors.push(`absolute path rejected: ${name}`);
      continue;
    }

    // Backslash paths
    if (name.includes('\\')) {
      errors.push(`backslash path rejected: ${name}`);
      continue;
    }

    // Traversal
    if (name.includes('..')) {
      errors.push(`traversal path rejected: ${name}`);
      continue;
    }

    // Non-canonical
    if (norm !== name) {
      errors.push(`non-canonical path rejected: ${name}`);
      continue;
    }

    // Duplicate
    if (names.has(name)) {
      errors.push(`duplicate entry: ${name}`);
      continue;
    }
    names.add(name);

    // Duplicate after normalization (catch a/../b = b)
    if (normNames.has(norm)) {
      errors.push(`duplicate normalized path: ${name} -> ${norm}`);
      continue;
    }
    normNames.add(norm);

    // Must be under package root
    if (!name.startsWith(prefix)) {
      errors.push(`entry outside package root: ${name}`);
      continue;
    }

    // Empty file path check (directories have length 0)
    const rel = name.slice(prefix.length);
    if (!rel) {
      // The package root directory itself — allowed
      hasRoot = true;
    }
  }

  if (!hasRoot) {
    // If there are entries under the prefix, the root exists implicitly
    const rootEntry = Array.from(names).find(n => n === prefix || n === `${packageName}/`);
    if (!rootEntry && names.size === 0) {
      errors.push('empty ZIP');
    }
  }

  return errors;
}

async function validateManifest(manifestPath, manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    errors.push('manifest is not a valid JSON object');
    return errors;
  }
  if (typeof manifest.schema_version !== 'string' || manifest.schema_version.trim().length === 0) {
    errors.push(`invalid or missing schema_version: ${manifest.schema_version}`);
  }
  if (manifest.package_name !== EXPECTED_PACKAGE_NAME) {
    errors.push(`unexpected package_name: ${manifest.package_name} (expected ${EXPECTED_PACKAGE_NAME})`);
  }
  if (manifest.producer !== EXPECTED_PRODUCER) {
    errors.push(`unexpected producer: ${manifest.producer} (expected ${EXPECTED_PRODUCER})`);
  }
  if (manifest.payload_profile !== EXPECTED_PROFILE) {
    errors.push(`unexpected payload_profile: ${manifest.payload_profile} (expected ${EXPECTED_PROFILE})`);
  }
  if (manifest.entrypoint !== ENTRY_DOCUMENT) {
    errors.push(`unexpected entrypoint: ${manifest.entrypoint} (expected ${ENTRY_DOCUMENT})`);
  }

  // Validate files array
  if (!Array.isArray(manifest.files)) {
    errors.push('manifest.files is not an array');
    return errors;
  }

  const filePaths = new Set();
  for (const f of manifest.files) {
    if (!f.path || typeof f.path !== 'string') {
      errors.push(`manifest file missing path: ${JSON.stringify(f)}`);
      continue;
    }
    if (!isSafeRelative(f.path)) {
      errors.push(`manifest file has unsafe path: ${f.path}`);
      continue;
    }
    if (filePaths.has(f.path)) {
      errors.push(`duplicate manifest path: ${f.path}`);
      continue;
    }
    filePaths.add(f.path);
    if (typeof f.sha256 !== 'string' || f.sha256.length !== 64) {
      errors.push(`manifest file "${f.path}" has invalid sha256: ${f.sha256}`);
    }
    if (typeof f.bytes !== 'number' || f.bytes < 0) {
      errors.push(`manifest file "${f.path}" has invalid bytes: ${f.bytes}`);
    }
  }

  return errors;
}

async function validatePackageContents(extractDir, packageName, manifest) {
  const errors = [];
  const pkgRoot = path.join(extractDir, packageName);

  // Verify every manifest-listed file exists with correct size and hash
  for (const f of manifest.files) {
    const filePath = path.join(pkgRoot, f.path);
    try {
      const s = await stat(filePath);
      if (!s.isFile()) {
        errors.push(`manifest entry is not a regular file: ${f.path}`);
        continue;
      }
      if (s.size !== f.bytes) {
        errors.push(`size mismatch for "${f.path}": expected ${f.bytes}, got ${s.size}`);
      }
      const hash = await sha256File(filePath);
      if (hash !== f.sha256) {
        errors.push(`sha256 mismatch for "${f.path}": expected ${f.sha256}, got ${hash}`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        errors.push(`manifest file missing: ${f.path}`);
      } else {
        errors.push(`cannot verify "${f.path}": ${e.message}`);
      }
    }
  }

  // Verify no unexpected files exist beyond manifest-listed files and package metadata
  const manifestPaths = new Set(manifest.files.map(f => f.path));
  // Package metadata files live at the package root and are not runtime content
  manifestPaths.add(MANIFEST_FILENAME);
  manifestPaths.add(CHECKSUM_FILENAME);
  await walkDir(pkgRoot, '', manifestPaths, errors);

  return errors;
}

async function walkDir(dir, prefix, manifestPaths, errors) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') {
      errors.push(`expected directory missing: ${prefix || '/'}`);
      return;
    }
    throw e;
  }

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    // Check for symlinks
    try {
      const lst = await lstat(fullPath);
      if (lst.isSymbolicLink()) {
        errors.push(`symlink rejected: ${relPath}`);
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }

    if (entry.isDirectory()) {
      await walkDir(fullPath, relPath, manifestPaths, errors);
    } else if (entry.isFile()) {
      if (!manifestPaths.has(relPath) && !relPath.startsWith('.')) {
        errors.push(`unexpected file not in manifest: ${relPath}`);
      }
    }
  }
}

// --- Transactional replacement ---

async function copyTree(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      const { copyFile } = await import('node:fs/promises');
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    }
  }
}

async function atomicReplace(srcDir, destDir, packageName) {
  const pkgSrc = path.join(srcDir, packageName);
  const staging = path.join(path.dirname(destDir), '.WebPayload-staging');

  // Remove old staging if present
  if (existsSync(staging)) {
    await rm(staging, { recursive: true, force: true });
  }

  // Copy package tree to staging
  await mkdir(staging, { recursive: true });
  await copyTree(pkgSrc, staging);

  // Write wrapper-owned redirect index.html outside the package subtree.
  // copyTree flattens the package root (fortweb-runtime/) into staging/,
  // so the canonical entrypoint app/index.html lives at staging/app/index.html.
  const redirectHtml = `<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=./app/index.html"></head>
<body><a href="./app/index.html">Launch FortWeb</a></body></html>\n`;
  await writeFile(path.join(staging, 'index.html'), redirectHtml);

  // Atomic swap: remove old dest, rename staging
  if (existsSync(destDir)) {
    const oldStaging = path.join(path.dirname(destDir), '.WebPayload-old');
    if (existsSync(oldStaging)) await rm(oldStaging, { recursive: true, force: true });
    await mkdir(path.dirname(oldStaging), { recursive: true });
    try {
      // On macOS, rename across filesystems may fail; use copy + rm fallback
      await rm(destDir, { recursive: true, force: true });
    } catch {
      // Fallback handled below
    }
  }

  try {
    const { rename } = await import('node:fs/promises');
    await rename(staging, destDir);
  } catch (e) {
    // Cross-device fallback
    if (existsSync(destDir)) await rm(destDir, { recursive: true, force: true });
    await copyTree(staging, destDir);
    await rm(staging, { recursive: true, force: true });
  }
}

// --- Main ---

async function importPackage(zipPath) {
  const packageName = EXPECTED_PACKAGE_NAME;
  const extractDir = path.join(tmpdir(), `fortweb-import-${Date.now()}`);

  console.log(`Importing: ${zipPath}`);

  // 1. Validate ZIP path
  if (!existsSync(zipPath)) {
    throw new Error(`ZIP not found: ${zipPath}`);
  }

  // 2. List and validate ZIP entries
  console.log('Validating ZIP structure...');
  const entries = listZipEntries(zipPath);
  if (entries.length === 0) {
    throw new Error('ZIP is empty or could not be read');
  }

  const zipErrors = validateZipEntries(entries, packageName);
  if (zipErrors.length > 0) {
    throw new Error(`ZIP structure validation failed:\n  ${zipErrors.join('\n  ')}`);
  }

  // 3. Extract to temp directory
  console.log('Extracting...');
  await mkdir(extractDir, { recursive: true });

  try {
    execSync(`unzip -qo "${zipPath}" -d "${extractDir}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`ZIP extraction failed: ${e.message}`);
  }

  // 4. Verify extracted tree has no symlinks
  console.log('Checking for symlinks and escapes...');
  const pkgRoot = path.join(extractDir, packageName);
  if (!existsSync(pkgRoot)) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Expected package root not found: ${packageName}/`);
  }

  const symlinkErrors = [];
  await checkSymlinks(extractDir, '', symlinkErrors);
  if (symlinkErrors.length > 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Symlink/escape validation failed:\n  ${symlinkErrors.join('\n  ')}`);
  }

  // 5. Read and validate manifest
  console.log('Validating manifest...');
  const manifestPath = path.join(pkgRoot, MANIFEST_FILENAME);
  let manifest;
  try {
    const manifestBytes = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(manifestBytes);
  } catch (e) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Cannot read manifest: ${e.message}`);
  }

  const manifestErrors = await validateManifest(manifestPath, manifest);
  if (manifestErrors.length > 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Manifest validation failed:\n  ${manifestErrors.join('\n  ')}`);
  }

  // 6. Verify package contents against manifest
  console.log(`Verifying ${manifest.files.length} files...`);
  const contentErrors = await validatePackageContents(extractDir, packageName, manifest);
  if (contentErrors.length > 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Content validation failed:\n  ${contentErrors.join('\n  ')}`);
  }

  // 7. Replace destination atomically
  console.log(`Staging to ${PAYLOAD_DEST}...`);
  await atomicReplace(extractDir, PAYLOAD_DEST, packageName);

  // 8. Clean up
  await rm(extractDir, { recursive: true, force: true });

  console.log(`Import complete: ${manifest.files.length} files staged`);
  console.log(`  package: ${manifest.package_name}`);
  console.log(`  sha:     ${manifest.git_sha}`);
  console.log(`  profile: ${manifest.payload_profile}`);
}

async function checkSymlinks(dir, prefix, errors) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    try {
      const lst = await lstat(fullPath);
      if (lst.isSymbolicLink()) {
        errors.push(`symlink rejected: ${relPath}`);
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }

    // Check containment
    if (!await isContained(dir, fullPath)) {
      errors.push(`path escapes extraction root: ${relPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      await checkSymlinks(fullPath, relPath, errors);
    }
  }
}

// --- CLI ---
const zipArg = process.argv[2];
if (!zipArg) {
  console.error('Usage: node tools/import-fortweb-runtime-package.mjs <runtime-package.zip>');
  process.exit(1);
}

importPackage(zipArg)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
