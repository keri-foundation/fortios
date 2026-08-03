#!/usr/bin/env node

/**
 * Read-only WebPayload drift/integrity diagnostic.
 *
 * Validates the staged payload against the FortWeb producer's manifest
 * and checksum contract. Derives all version and identity requirements
 * from producer-owned sources — never hardcodes them in the wrapper.
 *
 * Usage:
 *   node tools/assert-payload-integrity.mjs [--payload-dir <path>] [--target <id>]
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');

// --- Configuration ---

const PRODUCER_MANIFEST = 'manifest.json';
const PRODUCER_CHECKSUMS = 'checksums.sha256';
const EXPECTED_PACKAGE_NAME = 'fortweb-runtime';  // producer-owned identity

function parseArgs(argv) {
  const options = { root: defaultRoot, payloadDir: null, target: 'ios-webpayload' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { options.root = path.resolve(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--payload-dir') { options.payloadDir = path.resolve(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--target') { options.target = argv[i + 1]; i += 1; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.payloadDir) options.payloadDir = path.join(options.root, 'WebPayload');
  return options;
}

function violation(file, reason, expected) {
  return { file, reason, expected };
}

// --- Helpers ---

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isSafeRelative(p) {
  if (path.isAbsolute(p)) return false;
  if (p.includes('\\')) return false;
  const n = path.normalize(p);
  if (n !== p) return false;
  return !n.startsWith('..') && !n.split(path.sep).includes('..');
}

async function listFilesRec(absDir) {
  const entries = await readdir(absDir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) { files.push(...(await listFilesRec(p))); continue; }
    if (e.isFile()) files.push(p);
  }
  return files;
}

// --- Validation ---

async function readProducerManifest(payloadDir) {
  const manifestPath = path.join(payloadDir, PRODUCER_MANIFEST);
  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch {
    return { errors: [violation(PRODUCER_MANIFEST, 'missing producer manifest', `${PRODUCER_MANIFEST} must be present in the staged payload`)], manifest: null };
  }
  try {
    return { errors: [], manifest: JSON.parse(text) };
  } catch {
    return { errors: [violation(PRODUCER_MANIFEST, 'malformed producer manifest JSON', 'manifest must be valid JSON')], manifest: null };
  }
}

async function validateProducerIdentity(manifest) {
  const errors = [];
  const expected = 'Producer manifest must declare the expected package identity.';

  if (manifest.package_name !== EXPECTED_PACKAGE_NAME) {
    errors.push(violation(PRODUCER_MANIFEST, `package_name mismatch: expected ${EXPECTED_PACKAGE_NAME}, found ${manifest.package_name ?? 'missing'}`, expected));
  }

  if (typeof manifest.producer !== 'string' || manifest.producer.length === 0) {
    errors.push(violation(PRODUCER_MANIFEST, 'missing or empty producer field', expected));
  }

  if (typeof manifest.payload_profile !== 'string' || manifest.payload_profile.length === 0) {
    errors.push(violation(PRODUCER_MANIFEST, 'missing or empty payload_profile field', expected));
  }

  if (typeof manifest.entrypoint !== 'string' || manifest.entrypoint.length === 0) {
    errors.push(violation(PRODUCER_MANIFEST, 'missing or empty entrypoint field', expected));
  } else if (!isSafeRelative(manifest.entrypoint)) {
    errors.push(violation(PRODUCER_MANIFEST, `unsafe entrypoint path: ${manifest.entrypoint}`, expected));
  }

  return errors;
}

async function validateChecksums(payloadDir, manifest) {
  const errors = [];
  const expected = 'Every producer-declared file must exist with its declared SHA-256.';
  const checksumsPath = path.join(payloadDir, PRODUCER_CHECKSUMS);

  // Verify checksums file references manifest
  let checksumsText;
  try {
    checksumsText = (await readFile(checksumsPath, 'utf8')).trim();
  } catch {
    errors.push(violation(PRODUCER_CHECKSUMS, 'missing checksums file', expected));
    return errors;
  }

  const manifestBytes = await readFile(path.join(payloadDir, PRODUCER_MANIFEST));
  const manifestHash = sha256Buffer(manifestBytes);
  const expectedChecksumLine = `${manifestHash}  ${PRODUCER_MANIFEST}`;

  if (!checksumsText.includes(expectedChecksumLine)) {
    errors.push(violation(PRODUCER_CHECKSUMS, `manifest checksum mismatch in checksums file`, expected));
  }

  if (!Array.isArray(manifest.files)) {
    errors.push(violation(PRODUCER_MANIFEST, 'manifest.files is not an array', expected));
    return errors;
  }

  // Validate each manifest-listed file
  for (const f of manifest.files) {
    if (!isSafeRelative(f.path)) {
      errors.push(violation(PRODUCER_MANIFEST, `unsafe file path: ${f.path}`, expected));
      continue;
    }

    const filePath = path.join(payloadDir, f.path);
    try {
      const buf = await readFile(filePath);
      const hash = sha256Buffer(buf);
      if (hash !== f.sha256) {
        errors.push(violation(f.path, `SHA-256 mismatch: expected ${f.sha256}, got ${hash}`, expected));
      }
      if (buf.length !== f.bytes) {
        errors.push(violation(f.path, `byte size mismatch: expected ${f.bytes}, got ${buf.length}`, expected));
      }
      // Verify checksums file has this file's hash line
      if (!checksumsText.includes(`${f.sha256}  ${f.path}`)) {
        errors.push(violation(PRODUCER_CHECKSUMS, `checksums file missing entry for ${f.path}`, expected));
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        errors.push(violation(f.path, 'manifest-declared file is missing from payload', expected));
      } else {
        errors.push(violation(f.path, `cannot verify: ${e.message}`, expected));
      }
    }
  }

  return errors;
}

async function validateNoUnexpectedFiles(payloadDir, manifest) {
  const errors = [];
  const expected = 'Payload must not contain files not declared by the producer manifest.';

  const declared = new Set(manifest.files.map(f => f.path));
  declared.add(PRODUCER_MANIFEST);
  declared.add(PRODUCER_CHECKSUMS);

  // wrapper-owned redirect lives in payload root
  declared.add('index.html');

  const allFiles = await listFilesRec(payloadDir);
  for (const absPath of allFiles) {
    const relPath = path.relative(payloadDir, absPath);
    if (!declared.has(relPath) && !relPath.startsWith('.')) {
      errors.push(violation(relPath, 'file not declared in producer manifest', expected));
    }
  }

  return errors;
}

async function validateEntrypointExists(payloadDir, manifest) {
  const errors = [];
  const expected = 'Producer-declared entrypoint must exist in the staged payload.';

  const entryPath = path.join(payloadDir, manifest.entrypoint);
  try {
    const s = await fsStat(entryPath);
    if (!s.isFile()) {
      errors.push(violation(manifest.entrypoint, 'entrypoint is not a regular file', expected));
    }
  } catch {
    errors.push(violation(manifest.entrypoint, 'entrypoint file is missing', expected));
  }

  return errors;
}

// --- Main ---

async function main() {
  const { root, payloadDir, target } = parseArgs(process.argv.slice(2));

  console.log(`[payload-integrity] root: ${root}`);
  console.log(`[payload-integrity] payload directory: ${payloadDir}`);
  console.log(`[payload-integrity] target: ${target}`);

  // 1. Read producer manifest
  const { errors: readErrors, manifest } = await readProducerManifest(payloadDir);
  if (readErrors.length > 0) {
    for (const e of readErrors) printViolation(e);
    console.log('[payload-integrity] result: FAIL');
    process.exitCode = 1;
    return;
  }

  // Derive identity from producer, not hardcoded
  console.log(`[payload-integrity] producer: ${manifest.producer}`);
  console.log(`[payload-integrity] profile: ${manifest.payload_profile}`);
  console.log(`[payload-integrity] entrypoint: ${manifest.entrypoint}`);
  console.log(`[payload-integrity] schema_version: ${manifest.schema_version ?? 'missing'}`);
  console.log(`[payload-integrity] files declared: ${manifest.files?.length ?? 0}`);

  const allErrors = [
    ...(await validateProducerIdentity(manifest)),
    ...(await validateChecksums(payloadDir, manifest)),
    ...(await validateNoUnexpectedFiles(payloadDir, manifest)),
    ...(await validateEntrypointExists(payloadDir, manifest)),
  ];

  if (allErrors.length === 0) {
    console.log('[payload-integrity] result: PASS');
    return;
  }

  for (const e of allErrors) printViolation(e);
  console.log('[payload-integrity] result: FAIL');
  process.exitCode = 1;
}

function printViolation(item) {
  console.log('[payload-integrity] violation');
  console.log(`  file: ${item.file}`);
  console.log(`  reason: ${item.reason}`);
  console.log(`  expected: ${item.expected}`);
}

main().catch((error) => {
  console.error('[payload-integrity] result: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
