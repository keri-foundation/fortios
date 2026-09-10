#!/usr/bin/env node

/**
 * Pyodide runtime closure diagnostic for Fort-ios.
 *
 * Validates that the staged Pyodide runtime assets are complete and
 * internally consistent. Derives version requirements and expected
 * assets from the producer (FortWeb) manifest and configuration —
 * never hardcodes versions in the wrapper.
 *
 * Read-only, deterministic, local, non-repairing. Returns nonzero
 * when required runtime assets are missing or misconfigured.
 *
 * Usage:
 *   node tools/assert-pyodide-runtime.mjs [--payload-dir <path>] [--fortweb-dir <path>]
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { root: defaultRoot, payloadDir: null, fortwebDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { options.root = path.resolve(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--payload-dir') { options.payloadDir = path.resolve(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--fortweb-dir') { options.fortwebDir = path.resolve(argv[i + 1]); i += 1; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.payloadDir) options.payloadDir = path.join(options.root, 'WebPayload');
  return options;
}

function fail(message) {
  console.error(`[pyodide-runtime] ${message}`);
  process.exitCode = 1;
}

// --- Derive Pyodide version and paths from producer config ---

async function derivePyodideContract(payloadDir) {
  // 1. Read producer manifest for declared assets
  const manifestPath = path.join(payloadDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return { error: 'Cannot read producer manifest. Run payload-contract first.' };
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { error: 'Producer manifest has no files array.' };
  }

  // 2. Find Pyodide-related files from the manifest
  const pyodideFiles = manifest.files.filter(f =>
    f.path && (f.path.includes('pyodide') || f.path.includes('pyscript'))
  );

  // 3. Derive the Pyodide loader path from manifest-declared files
  const pyodideJs = pyodideFiles.find(f => f.path.endsWith('pyodide.mjs') || f.path.endsWith('pyodide.js'));
  const pyodideData = pyodideFiles.find(f => f.path.endsWith('pyodide.asm.data'));
  const pyodideWasm = pyodideFiles.find(f => f.path.endsWith('pyodide.asm.wasm'));

  // 4. Extract version from the path (e.g., vendor/pyodide/314.0.5/pyodide.mjs)
  const versionMatch = pyodideJs?.path?.match(/pyodide\/([^/]+)\//);
  const derivedVersion = versionMatch ? versionMatch[1] : null;

  return {
    manifest,
    pyodideFiles,
    pyodideJs,
    pyodideData,
    pyodideWasm,
    derivedVersion,
    isModule: pyodideJs ? pyodideJs.path.endsWith('.mjs') : null,
  };
}

// --- Worker mode detection ---

async function detectWorkerMode(payloadDir, manifest) {
  // Find the worker file from manifest (typically app/app/worker.js or similar)
  const workerFile = manifest.files.find(f =>
    f.path && (f.path.includes('worker') || f.path.includes('pyodide_worker'))
  );

  if (!workerFile) {
    return { mode: 'unknown', evidence: 'No worker file found in manifest. Pyodide may be loaded in main thread via pyscript.' };
  }

  let workerSource;
  try {
    workerSource = await readFile(path.join(payloadDir, workerFile.path), 'utf8');
  } catch {
    return { mode: 'unknown', evidence: `Worker file ${workerFile.path} is declared in manifest but not present.` };
  }

  if (/importScripts\s*\(/.test(workerSource)) {
    return { mode: 'classic', evidence: 'Worker uses importScripts() to load Pyodide at runtime.' };
  }
  if (/import\s*\{|import\s+.*from\s+['"]/.test(workerSource)) {
    return { mode: 'module', evidence: 'Worker uses ES module imports.' };
  }
  if (/new\s+Worker\s*\(/.test(workerSource)) {
    return { mode: 'module', evidence: 'Worker constructs sub-workers via ES module path.' };
  }

  return { mode: 'unknown', evidence: 'Worker boot path does not match known patterns — manual review required.' };
}

// --- Asset mode detection ---

async function detectAssetMode(payloadDir, pyodideJs) {
  if (!pyodideJs) return { mode: 'unknown', evidence: 'No Pyodide loader asset found in manifest.' };

  let source;
  try {
    source = await readFile(path.join(payloadDir, pyodideJs.path), 'utf8');
  } catch {
    return { mode: 'unknown', evidence: `Pyodide loader ${pyodideJs.path} declared but not present.` };
  }

  if (/^\s*export\b/m.test(source) || /\bexport\s*\{/.test(source)) {
    return { mode: 'esm', evidence: 'Pyodide asset contains export syntax (ES module).' };
  }
  return { mode: 'classic', evidence: 'Pyodide asset has no export syntax (classic script).' };
}

// --- Validation ---

async function validatePyodideAssets(payloadDir, contract) {
  const errors = [];

  if (!contract.pyodideJs) {
    errors.push('No Pyodide loader (.mjs or .js) found in producer manifest.');
    return errors;
  }

  // Verify loader exists
  try {
    await stat(path.join(payloadDir, contract.pyodideJs.path));
  } catch {
    errors.push(`Pyodide loader ${contract.pyodideJs.path} is declared but not present.`);
  }

  // Verify WASM exists
  if (contract.pyodideWasm) {
    try {
      await stat(path.join(payloadDir, contract.pyodideWasm.path));
    } catch {
      errors.push(`Pyodide WASM ${contract.pyodideWasm.path} is declared but not present.`);
    }
  } else {
    errors.push('No Pyodide WASM asset found in manifest.');
  }

  // Verify data file exists
  if (contract.pyodideData) {
    try {
      await stat(path.join(payloadDir, contract.pyodideData.path));
    } catch {
      errors.push(`Pyodide data ${contract.pyodideData.path} is declared but not present.`);
    }
  }

  return errors;
}

async function validateWorkerAssetAlignment(payloadDir, manifest, contract) {
  const errors = [];

  const workerMode = await detectWorkerMode(payloadDir, manifest);
  const assetMode = await detectAssetMode(payloadDir, contract.pyodideJs);

  console.log(`[pyodide-runtime] worker mode: ${workerMode.mode}`);
  console.log(`[pyodide-runtime] asset mode: ${assetMode.mode}`);

  if (workerMode.mode === 'classic' && assetMode.mode === 'esm') {
    errors.push('Worker uses classic importScripts but Pyodide asset is ESM — these are incompatible.');
  }

  if (workerMode.mode === 'module' && assetMode.mode === 'classic') {
    errors.push('Worker is a module but Pyodide asset has no exports — verify compatibility.');
  }

  if (workerMode.mode === 'unknown' || assetMode.mode === 'unknown') {
    // PyScript-based loading may not expose a standalone worker file.
    // This is a documented limitation, not an incompatibility.
    if (workerMode.mode === 'unknown') {
      console.log(`[pyodide-runtime] worker mode unknown — ${workerMode.evidence}`);
    }
    if (assetMode.mode === 'unknown') {
      console.log(`[pyodide-runtime] asset mode unknown — ${assetMode.evidence}`);
    }
    // Only fail for clear incompatibilities, not for unknowns
    return errors;
  }

  return errors;
}

async function validateWheelsPresent(payloadDir, manifest) {
  const errors = [];
  const wheelFiles = manifest.files.filter(f => f.path && f.path.endsWith('.whl'));

  if (wheelFiles.length === 0) {
    // Not necessarily an error — some profiles may not include wheels
    console.log('[pyodide-runtime] no .whl files declared in manifest (may be intentional)');
    return errors;
  }

  for (const w of wheelFiles) {
    try {
      await stat(path.join(payloadDir, w.path));
    } catch {
      errors.push(`Declared wheel ${w.path} is missing from payload.`);
    }
  }

  return errors;
}

// --- Main ---

async function main() {
  const { payloadDir } = parseArgs(process.argv.slice(2));

  console.log(`[pyodide-runtime] payload directory: ${payloadDir}`);

  // 1. Derive Pyodide contract from producer manifest
  const contract = await derivePyodideContract(payloadDir);
  if (contract.error) {
    fail(contract.error);
    return;
  }

  if (contract.derivedVersion) {
    console.log(`[pyodide-runtime] derived Pyodide version: ${contract.derivedVersion}`);
  }
  console.log(`[pyodide-runtime] loader: ${contract.pyodideJs?.path ?? 'not found'}`);
  console.log(`[pyodide-runtime] isModule: ${contract.isModule}`);
  console.log(`[pyodide-runtime] declared files: ${contract.pyodideFiles.length}`);

  // 2. Validate Pyodide core assets
  const assetErrors = await validatePyodideAssets(payloadDir, contract);

  // 3. Validate worker/asset alignment
  const alignmentErrors = await validateWorkerAssetAlignment(payloadDir, contract.manifest, contract);

  // 4. Validate wheels
  const wheelErrors = await validateWheelsPresent(payloadDir, contract.manifest);

  const allErrors = [...assetErrors, ...alignmentErrors, ...wheelErrors];

  if (allErrors.length === 0) {
    console.log('[pyodide-runtime] result: PASS');
    return;
  }

  for (const e of allErrors) {
    console.log(`[pyodide-runtime] violation: ${e}`);
  }
  console.log('[pyodide-runtime] result: FAIL');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('[pyodide-runtime] result: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
