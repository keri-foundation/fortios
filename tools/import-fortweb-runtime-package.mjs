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
 *   - contracts:      contracts/runtime-requirements.json
 *                     (manifest.contracts.runtime_requirements.path)
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
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, writeFile, symlink as fsSymlink } from 'node:fs/promises';
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
// Canonical contracts descriptor location declared by manifest.contracts.
const RUNTIME_REQUIREMENTS_PATH = 'contracts/runtime-requirements.json';

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
    // Argument array, not shell interpolation: a ZIP path containing shell
    // metacharacters must be treated as a literal filesystem path.
    const out = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return parseUnzipList(out);
  } catch (e) {
    throw new Error(`Cannot list ZIP entries: ${e.message}`);
  }
}

function parseUnzipList(output) {
  // Parse `unzip -l` output without depending on date format.
  //
  // Column layout (macOS MM-DD-YYYY, Ubuntu YYYY-MM-DD, any locale):
  //     Length      Date    Time    Name
  //   --------  ---------- -----   ----
  //       1234  01-01-2026 00:00   path/to/file
  //       1234  2026-01-01 00:00   path/to/file
  //
  // Strategy: anchor on the time column (HH:MM) which is stable across
  // platforms.  Split each line at the time, take the first number from
  // the left side as the byte length, and everything after the time as
  // the filename.

  const TIME_RE = /\b(\d{2}:\d{2})\b/;

  const entries = [];
  const lines = output.split('\n');
  let inEntries = false;

  for (const line of lines) {
    if (line.startsWith(' --------') || line.startsWith('---------')) {
      inEntries = !inEntries;
      continue;
    }
    if (!inEntries) continue;

    const timeMatch = line.match(TIME_RE);
    if (!timeMatch) continue; // summary / footer line, no time column

    const timeIdx = timeMatch.index;
    const beforeTime = line.slice(0, timeIdx);
    const afterTime = line.slice(timeIdx + timeMatch[0].length);

    // First run of digits in the left portion is the byte length
    const sizeMatch = beforeTime.match(/(\d+)/);
    if (!sizeMatch) continue;

    const name = afterTime.trim();
    if (!name) continue;

    entries.push({ length: parseInt(sizeMatch[1], 10), name });
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

  // The producer declares its contracts descriptor location. The importer
  // requires that exact relative path: a package whose contracts pointer is
  // missing, unsafe, or relocated is not a canonical runtime package.
  const requirementsPath = manifest.contracts?.runtime_requirements?.path;
  if (typeof requirementsPath !== 'string' || requirementsPath.length === 0) {
    errors.push('manifest.contracts.runtime_requirements.path is missing');
  } else if (!isSafeRelative(requirementsPath)) {
    errors.push(`manifest.contracts.runtime_requirements.path is unsafe: ${requirementsPath}`);
  } else if (requirementsPath !== RUNTIME_REQUIREMENTS_PATH) {
    errors.push(`unexpected manifest.contracts.runtime_requirements.path: ${requirementsPath} (expected ${RUNTIME_REQUIREMENTS_PATH})`);
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
      // Complete inventory check. The only tolerated extras are the reserved
      // package metadata files added to manifestPaths above; there is no
      // dot-prefix exemption, so an undeclared hidden file fails the import.
      if (!manifestPaths.has(relPath)) {
        errors.push(`unexpected file not in manifest: ${relPath}`);
      }
    }
  }
}

// --- Transactional replacement ---

/**
 * Verify the package checksum file against the extracted candidate bytes.
 *
 * Contract (from FortWeb `tools/package-runtime.mjs`):
 *   - `checksums.sha256` lives at the package root and is REQUIRED.
 *   - Rows are `<64-lowercase-hex>  <path>` (two spaces), sha256sum format.
 *   - Rows cover reserved package metadata; payload files are covered by
 *     `manifest.files` and verified separately.
 *   - The file does not hash itself.
 *
 * All digests are recomputed from actual extracted bytes. The manifest, the
 * ZIP metadata, and filenames are never trusted in place of byte hashing.
 *
 * @param {string} pkgRoot - extracted package root (`<extractDir>/<packageName>`)
 * @param {object} manifest - parsed package manifest
 * @param {Buffer} manifestRawBytes - raw bytes of manifest.json
 * @returns {Promise<string[]>} human-readable violations (empty when valid)
 */
async function validateChecksums(pkgRoot, manifest, manifestRawBytes) {
  const errors = [];
  const checksumPath = path.join(pkgRoot, CHECKSUM_FILENAME);

  let text;
  try {
    text = await readFile(checksumPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return [`required package metadata missing: ${CHECKSUM_FILENAME}`];
    }
    return [`cannot read ${CHECKSUM_FILENAME}: ${e.message}`];
  }

  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [`${CHECKSUM_FILENAME} is empty`];
  }

  const declared = new Set(manifest.files.map((f) => f.path));
  const reserved = new Set([MANIFEST_FILENAME, CHECKSUM_FILENAME]);
  const seen = new Set();
  const rows = [];

  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`${CHECKSUM_FILENAME} has a malformed row: ${JSON.stringify(line)}`);
      continue;
    }
    const [, digest, relPath] = match;
    if (!isSafeRelative(relPath)) {
      errors.push(`${CHECKSUM_FILENAME} has an unsafe path: ${relPath}`);
      continue;
    }
    if (seen.has(relPath)) {
      errors.push(`${CHECKSUM_FILENAME} has a duplicate path: ${relPath}`);
      continue;
    }
    seen.add(relPath);
    // A row may reference reserved package metadata or a manifest-declared
    // payload file. Nothing else is permitted.
    if (!reserved.has(relPath) && !declared.has(relPath)) {
      errors.push(`${CHECKSUM_FILENAME} references an undeclared path: ${relPath}`);
      continue;
    }
    rows.push({ digest, relPath });
  }
  if (errors.length > 0) {
    return errors;
  }

  const manifestRow = rows.find((row) => row.relPath === MANIFEST_FILENAME);
  if (!manifestRow) {
    errors.push(`${CHECKSUM_FILENAME} does not cover ${MANIFEST_FILENAME}`);
  } else {
    const actual = await sha256Buffer(manifestRawBytes);
    if (actual !== manifestRow.digest) {
      errors.push(`${CHECKSUM_FILENAME} mismatch for "${MANIFEST_FILENAME}": expected ${manifestRow.digest}, got ${actual}`);
    }
  }

  for (const row of rows) {
    if (row.relPath === MANIFEST_FILENAME) {
      continue;
    }
    const target = path.join(pkgRoot, row.relPath);
    try {
      const targetStat = await stat(target);
      if (!targetStat.isFile()) {
        errors.push(`${CHECKSUM_FILENAME} entry is not a regular file: ${row.relPath}`);
        continue;
      }
      const actual = await sha256File(target);
      if (actual !== row.digest) {
        errors.push(`${CHECKSUM_FILENAME} mismatch for "${row.relPath}": expected ${row.digest}, got ${actual}`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        errors.push(`${CHECKSUM_FILENAME} references a missing file: ${row.relPath}`);
      } else {
        errors.push(`cannot verify "${row.relPath}": ${e.message}`);
      }
    }
  }

  return errors;
}

/**
 * Verify the package contracts descriptor referenced by the manifest.
 *
 * Contract (from FortWeb `tools/package-runtime.mjs` #38):
 *   - `manifest.contracts.runtime_requirements.path` points at a declared
 *     payload file that carries the runtime requirements the host must honour.
 *   - That file is strict UTF-8 JSON whose `producer` and `payload_profile`
 *     echo the manifest, so a host can never pair a payload with a foreign
 *     requirements descriptor.
 *
 * Only fields that exist in the canonical producer output are required.
 *
 * @param {string} pkgRoot - extracted package root
 * @param {object} manifest - parsed package manifest
 * @returns {Promise<string[]>} human-readable violations (empty when valid)
 */
async function validateRuntimeRequirements(pkgRoot, manifest) {
  const errors = [];
  const requirementsPath = manifest.contracts?.runtime_requirements?.path;
  if (typeof requirementsPath !== 'string' || requirementsPath.length === 0) {
    return ['manifest.contracts.runtime_requirements.path is missing'];
  }

  const descriptorPath = path.join(pkgRoot, requirementsPath);
  let raw;
  try {
    // fatal decoding rejects invalid UTF-8 rather than silently replacing bytes.
    raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(descriptorPath));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return [`runtime requirements descriptor missing: ${requirementsPath}`];
    }
    return [`cannot read runtime requirements descriptor: ${e.message}`];
  }

  if (raw.includes('\uFFFD')) {
    errors.push(`${requirementsPath}: contains U+FFFD replacement characters`);
  }

  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch (e) {
    errors.push(`${requirementsPath}: invalid JSON: ${e.message}`);
    return errors;
  }

  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    errors.push(`${requirementsPath}: must be a JSON object`);
    return errors;
  }
  if (typeof descriptor.schema !== 'string' || descriptor.schema.trim().length === 0) {
    errors.push(`${requirementsPath}: missing or invalid schema`);
  }
  if (descriptor.producer !== manifest.producer) {
    errors.push(`${requirementsPath}: producer mismatch (expected "${manifest.producer}", got "${descriptor.producer ?? '(missing)'}")`);
  }
  if (descriptor.payload_profile !== manifest.payload_profile) {
    errors.push(`${requirementsPath}: payload_profile mismatch (expected "${manifest.payload_profile}", got "${descriptor.payload_profile ?? '(missing)'}")`);
  }

  return errors;
}

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

/**
 * Activate a validated package tree as the live payload.
 *
 * Guarantees:
 *  - A previously valid destination is never deleted before a complete
 *    replacement is verified.
 *  - The final switch uses same-directory rename (atomic on the destination
 *    filesystem).
 *  - If activation fails, the previous destination is restored.
 *  - Cross-device staging writes to a sibling directory under the destination
 *    parent, so the final rename stays on the same filesystem.
 *
 * Classification: ATOMIC_ACTIVATION_WITH_ROLLBACK_SAFE_PREPARATION
 *
 * @param {string} srcDir - extraction root (may be on a different filesystem)
 * @param {string} destDir - live destination path
 * @param {string} packageName - expected package root name inside srcDir
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - if true, prepare but do not activate
 */
async function atomicReplace(srcDir, destDir, packageName, options = {}) {
  const { rename } = await import('node:fs/promises');
  const parentDir = path.dirname(destDir);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const destBasename = path.basename(destDir);

  // Build the validated package tree inside a sibling of the destination,
  // so the final rename is always same-directory (atomic on that filesystem).
  const newSibling = path.join(parentDir, `.${destBasename}-new-${nonce}`);
  const backupSibling = path.join(parentDir, `.${destBasename}-old-${nonce}`);
  const pkgSrc = path.join(srcDir, packageName);

  // 1. Remove any leftover sibling from a prior crashed run
  if (existsSync(newSibling)) {
    await rm(newSibling, { recursive: true, force: true });
  }
  if (existsSync(backupSibling)) {
    await rm(backupSibling, { recursive: true, force: true });
  }

  // 2. Copy validated package into the new sibling (may cross filesystems)
  await mkdir(newSibling, { recursive: true });
  await copyTree(pkgSrc, newSibling);

  // 3. Write wrapper-owned redirect — this is NOT part of the package
  const redirectHtml = `<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=./app/index.html"></head>
<body><a href="./app/index.html">Launch FortWeb</a></body></html>\n`;
  await writeFile(path.join(newSibling, 'index.html'), redirectHtml);

  // 4. Verify the new sibling is complete (basic sanity: manifest exists)
  const newManifestPath = path.join(newSibling, 'manifest.json');
  if (!existsSync(newManifestPath)) {
    throw new Error('Staged replacement is missing manifest.json — aborting activation');
  }

  if (options.dryRun) {
    // Test-only: leave newSibling and backupSibling for inspection
    return;
  }

  // Test-only: simulate activation failure for rollback proof
  if (process.env.FORTWEB_IMPORT_SIMULATE_ACTIVATION_FAILURE === '1') {
    throw new Error('SIMULATED_ACTIVATION_FAILURE');
  }

  const hadExisting = existsSync(destDir);

  try {
    // 5. If a live destination exists, move it aside (same-filesystem rename)
    if (hadExisting) {
      await rename(destDir, backupSibling);
    }

    // 6. Activate the new payload (same-filesystem rename)
    try {
      await rename(newSibling, destDir);
    } catch (activationError) {
      // Rollback: restore the previous destination
      if (hadExisting) {
        try { await rename(backupSibling, destDir); } catch { /* best effort */ }
      }
      throw activationError;
    }

    // 7. Clean up backup now that activation succeeded
    if (hadExisting) {
      await rm(backupSibling, { recursive: true, force: true });
    }
  } finally {
    // 8. Always clean newSibling if it still exists (failed activation)
    if (existsSync(newSibling)) {
      await rm(newSibling, { recursive: true, force: true });
    }
    // Clean backup if somehow left behind
    if (existsSync(backupSibling)) {
      await rm(backupSibling, { recursive: true, force: true });
    }
  }
}

// --- Main ---

async function importPackage(zipPath) {
  const packageName = EXPECTED_PACKAGE_NAME;
  // Unpredictable, exclusively-created candidate directory. All validation
  // happens against this candidate, never against the live payload.
  const extractDir = await mkdtemp(path.join(tmpdir(), 'fortweb-import-'));

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
    // Argument array, not shell interpolation (see listZipEntries).
    execFileSync('unzip', ['-qo', zipPath, '-d', extractDir], {
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
  let manifestRawBytes;
  try {
    // Retain the raw bytes: the package checksum file covers manifest.json, so
    // its digest must be computed over exactly these bytes.
    manifestRawBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestRawBytes.toString('utf8'));
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

  // 7. Verify the required package checksum file against extracted bytes.
  // This runs before any replacement: a checksum failure must leave the
  // previously staged payload byte-for-byte unchanged.
  console.log('Verifying package checksums...');
  const checksumErrors = await validateChecksums(pkgRoot, manifest, manifestRawBytes);
  if (checksumErrors.length > 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Checksum validation failed:\n  ${checksumErrors.join('\n  ')}`);
  }

  // 8. Verify the declared runtime/package contracts descriptor.
  console.log('Verifying runtime requirements...');
  const requirementsErrors = await validateRuntimeRequirements(pkgRoot, manifest);
  if (requirementsErrors.length > 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error(`Runtime requirements validation failed:\n  ${requirementsErrors.join('\n  ')}`);
  }

  // 9. Replace destination atomically. This is the first and only point at
  // which the live payload is touched.
  console.log(`Staging to ${PAYLOAD_DEST}...`);
  const dryRun = process.env.FORTWEB_IMPORT_DRY_RUN === '1';
  await atomicReplace(extractDir, PAYLOAD_DEST, packageName, { dryRun });

  // 10. Clean up
  await rm(extractDir, { recursive: true, force: true });

  console.log(`Import complete: ${manifest.files.length} files staged`);
  console.log(`  package: ${manifest.package_name}`);
  console.log(`  commit:  ${manifest.fortweb_commit_sha}`);
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
