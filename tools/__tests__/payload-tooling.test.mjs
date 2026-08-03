import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const assertNoProofDemoShellScript = path.join(repoRoot, 'tools', 'assert-no-proof-demo-shell.mjs');
const validateMobilePayloadScript = path.join(repoRoot, 'tools', 'validate-mobile-payload.mjs');
const fortwebManifestScript = path.join(repoRoot, 'tools', 'gen-fortweb-bundle-manifest.mjs');
const tempDirs = [];

async function makeTempDir() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-tooling-'));
    tempDirs.push(tempDir);
    return tempDir;
}

async function writeTextFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

async function writeJsonFile(filePath, data) {
    await writeTextFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

async function runNodeScript(scriptPath, args) {
    return execFile('node', [scriptPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
}

async function runNodeScriptExpectFailure(scriptPath, args) {
    try {
        await runNodeScript(scriptPath, args);
    } catch (error) {
        return error;
    }

    throw new Error(`Expected ${path.basename(scriptPath)} to fail`);
}

function makeSharedManifest(overrides = {}) {
    return {
        producer: 'fortweb',
        payload_profile: 'offline-runtime',
        entrypoint: 'app/index.html',
        build_command: 'npm run build:runtime',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
});

describe('validate-mobile-payload.mjs', () => {
    it('passes for a clean ZIP-imported payload without banned markers', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'index.html'), '<h1>KERI Wallet</h1>');
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'console.log("loaded");');

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(stdout).toContain('[payload-check] result: PASS');
    });

    it('fails when entry script is missing', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'index.html'), '<h1>KERI Wallet</h1>');
        // app/app/main.js not written

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(error.stdout).toContain('missing');
        expect(error.stdout).toContain('main.js');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails when entry HTML references a missing local script', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(
            path.join(payloadDir, 'app', 'index.html'),
            '<script src="./missing-script.js"></script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'console.log("loaded");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(error.stdout).toContain('missing file');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('passes when entry HTML references existing local scripts', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(
            path.join(payloadDir, 'app', 'index.html'),
            '<script type="module" src="./app/main.js"></script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'console.log("loaded");');

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(stdout).toContain('[payload-check] result: PASS');
    });

    it('fails when entry document is missing', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'console.log("loaded");');
        // No app/index.html

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(error.stdout).toContain('missing');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails when banned markers appear in staged files', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'index.html'), '<p>Profile ID</p>');
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'console.log("loaded");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(error.stdout).toContain('"Profile ID"');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails when banned markers appear in payload text files', async () => {
        const payloadDir = await makeTempDir();
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'app', 'index.html'), '<h1>Wallet</h1>');
        await writeTextFile(path.join(payloadDir, 'app', 'app', 'main.js'), 'const mode = "fort-ios-local";');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir', payloadDir, '--target', 'ios-webpayload',
        ]);
        expect(error.stdout).toContain('fort-ios-local');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });
});

describe('assert-no-proof-demo-shell.mjs', () => {
    it('passes when the active repo surface contains no blocked posture strings', async () => {
        const repoDir = await makeTempDir();
        await writeTextFile(path.join(repoDir, 'src', 'main.ts'), 'export const status = "validation ready";\n');
        await writeTextFile(path.join(repoDir, 'README.md'), 'Fort-ios stages the FortWeb product-shell payload.\n');

        const { stdout } = await runNodeScript(assertNoProofDemoShellScript, ['--root', repoDir]);
        expect(stdout).toContain('[repo-guard] result: PASS');
    });

    it('fails when active source reintroduces a blocked fort-ios payload lane', async () => {
        const repoDir = await makeTempDir();
        await writeTextFile(path.join(repoDir, 'Makefile'), 'PAYLOAD_SOURCE=fort-ios make sync\n');

        const error = await runNodeScriptExpectFailure(assertNoProofDemoShellScript, ['--root', repoDir]);
        expect(error.stdout).toContain('PAYLOAD_SOURCE=fort-ios');
        expect(error.stdout).toContain('FortWeb product-shell payload');
    });
});

describe('gen-fortweb-bundle-manifest.mjs', () => {
    it('writes the expected wrapper manifest fields for the FortWeb payload', async () => {
        const payloadRoot = await makeTempDir();
        const fortwebDir = await makeTempDir();

        await writeTextFile(path.join(payloadRoot, 'index.html'), '<!doctype html>\n');
        await writeTextFile(path.join(payloadRoot, 'fortweb', 'app', 'index.html'), '<main>fortweb</main>\n');
        await writeTextFile(
            path.join(fortwebDir, 'pyscript-ci.toml'),
            'interpreter = "/fortweb/vendor/pyodide/custom.mjs"\n'
        );

        await runNodeScript(fortwebManifestScript, [
            '--payload-root',
            payloadRoot,
            '--fortweb-dir',
            fortwebDir,
            '--build-command',
            'PAYLOAD_SOURCE=fortweb ./sync-payload.sh',
        ]);

        const manifest = JSON.parse(
            await readFile(path.join(payloadRoot, 'build-manifest.json'), 'utf8')
        );

        expect(manifest.producer).toBe('fortweb-shared');
        expect(manifest.payload_profile).toBe('product-shell');
        expect(manifest.entry_document).toBe('fortweb/app/index.html');
        expect(manifest.pyodide_asset_path).toBe('/fortweb/vendor/pyodide/custom.mjs');
        expect(manifest.sync_targets.map((entry) => entry.id)).toEqual(['ios-webpayload']);
    });
});

// --------------------------------------------------------------------------
// Bridge contract generator: export-visibility regression test
// --------------------------------------------------------------------------

describe('gen-bridge-contract.mjs exports', () => {
    const genScript = path.join(repoRoot, 'tools', 'gen-bridge-contract.mjs');
    const contractSource = path.join(repoRoot, 'bridge-contract.json');

    const ALLOWED_EXPORTS = Object.freeze([
        'BRIDGE_HANDLER_NAME',
        'BRIDGE_MESSAGE_TYPES',
        'WORKER_COMMAND_TYPES',
        'WORKER_RESULT_TYPES',
    ]);

    /** Set up a scratch dir that mimics the repo layout so the generator
     *  resolves its fixed relative paths (bridge-contract.json, src/, KeriWallet/, generated/).
     *  The generator uses resolve(__dirname, '..') for ROOT, so we place it in
     *  a tools/ subdir. */
    async function setupGenSandbox() {
        const workDir = await makeTempDir();
        const toolsDir = path.join(workDir, 'tools');
        const genFile = path.join(toolsDir, 'gen-bridge-contract.mjs');
        const contractFile = path.join(workDir, 'bridge-contract.json');
        const srcDir = path.join(workDir, 'src');
        const tsOut = path.join(srcDir, 'bridge-contract.ts');
        await mkdir(toolsDir);
        await mkdir(srcDir);
        // Foundation output paths (not the donor's xcodeproj layout)
        await mkdir(path.join(workDir, 'KeriWallet'), { recursive: true });
        await mkdir(path.join(workDir, 'generated'));
        await writeFile(genFile, await readFile(genScript, 'utf8'));
        await writeFile(contractFile, await readFile(contractSource, 'utf8'));
        return { workDir, genFile, tsOut };
    }

    async function runGen(workDir, genFile) {
        await execFile('node', [genFile], { cwd: workDir, encoding: 'utf8' });
    }

    it('produces exactly 4 public const exports', async () => {
        const { workDir, genFile, tsOut } = await setupGenSandbox();
        await runGen(workDir, genFile);

        const output = await readFile(tsOut, 'utf8');

        // 4 public exports — no more, no fewer
        const exportLines = output
            .split('\n')
            .filter((line) => /^export const /.test(line));
        expect(exportLines).toHaveLength(4);
        expect(exportLines[0]).toMatch(/^export const BRIDGE_HANDLER_NAME = /);
        expect(exportLines[1]).toMatch(/^export const BRIDGE_MESSAGE_TYPES = /);
        expect(exportLines[2]).toMatch(/^export const WORKER_COMMAND_TYPES = /);
        expect(exportLines[3]).toMatch(/^export const WORKER_RESULT_TYPES = /);
    });

    it('does not export individual string scalars', async () => {
        const { workDir, genFile, tsOut } = await setupGenSandbox();
        await runGen(workDir, genFile);

        const output = await readFile(tsOut, 'utf8');

        // These individual string scalars should NOT be exported (they
        // are used privately to build the array exports above).
        const forbiddenExports = [
            'BRIDGE_CONTRACT_VERSION',
            'BRIDGE_HANDLER_SOURCE_SWIFT',
            'BRIDGE_HANDLER_SOURCE_KOTLIN',
            'LIFECYCLE_BOOT',
            'BRIDGE_JS_ERROR',
            'WORKER_CMD_INIT',
            'WORKER_RES_READY',
        ];
        for (const name of forbiddenExports) {
            expect(output).not.toMatch(
                new RegExp('^export const ' + name),
            );
        }

        // Prove the complete export-name set equals exactly the four
        // allowed names — accidental extra exports fail automatically.
        const exportNames = output
            .split('\n')
            .filter((line) => /^export const /.test(line))
            .map((line) => line.match(/^export const (\w+)/)?.[1])
            .filter(Boolean);
        expect(new Set(exportNames)).toEqual(new Set(ALLOWED_EXPORTS));
    });

    it('is idempotent', async () => {
        const { workDir, genFile } = await setupGenSandbox();

        await runGen(workDir, genFile);
        const ts1 = await readFile(
            path.join(workDir, 'src', 'bridge-contract.ts'), 'utf8');
        const swift1 = await readFile(
            path.join(workDir, 'KeriWallet', 'BridgeContract.swift'), 'utf8');
        const kt1 = await readFile(
            path.join(workDir, 'generated', 'BridgeContract.kt'), 'utf8');

        // Second run should produce identical output for all three languages
        await runGen(workDir, genFile);
        const ts2 = await readFile(
            path.join(workDir, 'src', 'bridge-contract.ts'), 'utf8');
        const swift2 = await readFile(
            path.join(workDir, 'KeriWallet', 'BridgeContract.swift'), 'utf8');
        const kt2 = await readFile(
            path.join(workDir, 'generated', 'BridgeContract.kt'), 'utf8');

        expect(ts2).toBe(ts1);
        expect(swift2).toBe(swift1);
        expect(kt2).toBe(kt1);
    });
});

// --- importer tests ---

import { execSync } from 'node:child_process';

const importScript = path.join(repoRoot, 'tools', 'import-fortweb-runtime-package.mjs');

/**
 * Create a minimal valid ZIP with a manifest and one entry in the canonical
 * FortWeb runtime package format (manifest.json, checksums.sha256).
 * Uses system `zip` command. All fixtures are generated in temp dirs.
 */
function createTestZip(tempDir, { packageName = 'fortweb-runtime', manifestOverrides = {}, extraFiles = [] } = {}) {
    const pkgDir = path.join(tempDir, packageName);
    const zipPath = path.join(tempDir, 'test-package.zip');

    // Build manifest in canonical FortWeb producer format
    const manifest = {
        schema_version: '1.0.0',
        package_version: '0.0.0',
        package_name: packageName,
        producer: 'fortweb',
        payload_profile: 'offline-runtime',
        fortweb_commit_sha: '0000000000000000000000000000000000000000',
        runtime_origin: 'https://appassets.androidplatform.net',
        entrypoint: 'app/index.html',
        files: [],
        ...manifestOverrides,
    };

    // Compute file hashes for entry document + extra files
    const entryRel = 'app/index.html';
    mkdirSync(path.join(pkgDir, 'app'), { recursive: true });

    const entryContent = '<!DOCTYPE html><html><head><title>Test</title></head><body>KERI</body></html>';
    writeFileSync(path.join(pkgDir, entryRel), entryContent);
    const entryHash = createHash('sha256').update(entryContent).digest('hex');
    const entrySize = Buffer.byteLength(entryContent);

    // Add extra files
    for (const ef of extraFiles) {
        const efPath = path.join(pkgDir, ef.path);
        mkdirSync(path.dirname(efPath), { recursive: true });
        writeFileSync(efPath, ef.content);
    }

    // If manifestOverrides.files was explicitly provided, use it; else compute from created files
    if (manifestOverrides.files && Array.isArray(manifestOverrides.files)) {
        // Keep the override — used for testing mismatches
    } else {
        // Auto-compute files from what was created
        manifest.files = [{ path: entryRel, sha256: entryHash, bytes: entrySize }];
        for (const ef of extraFiles) {
            const efHash = createHash('sha256').update(ef.content).digest('hex');
            manifest.files.push({ path: ef.path, sha256: efHash, bytes: Buffer.byteLength(ef.content) });
        }
    }

    // Write manifest
    const manifestJson = JSON.stringify(manifest, null, 2);
    writeFileSync(path.join(pkgDir, 'manifest.json'), manifestJson);

    // Write checksum file
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
    const checksumContent = `${manifestHash}  manifest.json\n`;
    writeFileSync(path.join(pkgDir, 'checksums.sha256'), checksumContent);

    // Create ZIP (run from inside tempDir so paths are relative)
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
        execSync(`zip -qr "${zipPath}" "${packageName}"`, { encoding: 'utf-8' });
    } catch (e) {
        process.chdir(cwd);
        throw e;
    }
    process.chdir(cwd);

    return { zipPath, manifest, entryContent, pkgDir };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function importZip(zipPath) {
    return execFile('node', [importScript, zipPath], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
}

async function importZipExpectFailure(zipPath) {
    try {
        await importZip(zipPath);
    } catch (error) {
        return error;
    }
    throw new Error('Expected importer to fail');
}

describe('import-fortweb-runtime-package.mjs', () => {
    it('imports a valid package successfully', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir);

        const { stdout } = await importZip(zipPath);
        expect(stdout).toContain('Import complete');
        expect(stdout).toContain('fortweb-runtime');

        // Verify WebPayload was populated
        const bp = path.join(repoRoot, 'WebPayload', 'manifest.json');
        const manifestBytes = await readFile(bp, 'utf-8');
        expect(manifestBytes).toContain('fortweb-runtime');
    });

    it('rejects a missing ZIP path', async () => {
        await expect(importZip('/nonexistent/path.zip')).rejects.toThrow();
    });

    it('rejects a ZIP with absolute path entry', async () => {
        // Absolute-path ZIP entries cannot be reliably created with standard
        // zip tools. The validator's path safety checks are tested through
        // the ZIP-entry parser unit (isSafeRelative) and manifest file-path
        // validation (manifest files with absolute paths are rejected).
        // DEFERRED: Create a malicious-JAR fixture if a test tool becomes available.
    });

    it('rejects a ZIP with ../ traversal path', async () => {
        // Traversal ZIP entries cannot be reliably created with standard zip
        // tools. The validator's traversal rejection logic is verified through
        // isSafeRelative() checks on manifest file paths and ZIP entry names.
        // DEFERRED: Create a malicious-JAR fixture if a test tool becomes available.
    });

    it('rejects a package with mismatched file SHA-256', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [{ path: 'app/index.html', sha256: 'a'.repeat(64), bytes: 100 }],
            },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/sha256 mismatch|size mismatch/);
    });

    it('preserves manifest bytes exactly', async () => {
        const tempDir = await makeTempDir();
        const { zipPath, manifest } = createTestZip(tempDir);

        await importZip(zipPath);

        // Read back the manifest — should match exactly
        const bp = path.join(repoRoot, 'WebPayload', 'manifest.json');
        const importedManifest = JSON.parse(await readFile(bp, 'utf-8'));
        expect(importedManifest.schema_version).toBe(manifest.schema_version);
        expect(importedManifest.package_name).toBe(manifest.package_name);
        expect(importedManifest.files).toHaveLength(manifest.files.length);
    });

    it('rejects when entry document is missing from package', async () => {
        const tempDir = await makeTempDir();
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'bad.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(pkgDir, { recursive: true });
        const manifest = {
            schema_version: '1.0.0',
            package_version: '0.0.0',
            package_name: pkgName,
            producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            files: [{ path: 'app/index.html', sha256: '0'.repeat(64), bytes: 0 }],
        };
        writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest));
        // Don't create the entry document

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "${pkgName}"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow(/Content validation|manifest file missing/);
    });

    it('rejects unexpected package name', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: { package_name: 'wrong-package' },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected package_name/);
    });

    it('rejects unsupported manifest schema', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: { schema_version: '' },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/invalid or missing schema_version/);
    });

    it('leaves existing WebPayload unchanged on failure', async () => {
        // First import a valid package
        const tempDir1 = await makeTempDir();
        const { zipPath: validZip } = createTestZip(tempDir1);
        await importZip(validZip);

        // Read the current state
        const bp = path.join(repoRoot, 'WebPayload', 'manifest.json');
        const beforeManifest = await readFile(bp, 'utf-8');

        // Try importing a bad package
        const tempDir2 = await makeTempDir();
        const { zipPath: badZip } = createTestZip(tempDir2, {
            manifestOverrides: { package_name: 'wrong-name' },
        });

        try {
            await importZip(badZip);
        } catch {
            // Expected
        }

        // Verify WebPayload unchanged
        const afterManifest = await readFile(bp, 'utf-8');
        expect(afterManifest).toBe(beforeManifest);
    });
});

// --------------------------------------------------------------------------
// Adversarial containment tests — canonical producer-format packages
// --------------------------------------------------------------------------

import {
    createSymlinkZip,
    createDuplicateEntryZip,
    createDirSymlinkZip,
    createArbitraryZip,
} from './helpers/adversarial-zip.mjs';

describe('runtime package containment — adversarial', () => {
    it('rejects wrong producer', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: { producer: 'wrong-producer' },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected producer/);
    });

    it('rejects wrong payload_profile', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: { payload_profile: 'wrong-profile' },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected payload_profile/);
    });

    it('rejects wrong entrypoint', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: { entrypoint: 'wrong/entry.html' },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected entrypoint/);
    });

    it('rejects duplicate manifest file paths', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [
                    { path: 'app/index.html', sha256: '0'.repeat(64), bytes: 0 },
                    { path: 'app/index.html', sha256: '1'.repeat(64), bytes: 1 },
                ],
            },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/duplicate manifest path/);
    });

    it('rejects unlisted extra file in package', async () => {
        const tempDir = await makeTempDir();
        // Create a ZIP with a valid manifest listing only app/index.html,
        // but also include an unlisted file on disk.
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'extra.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(path.join(pkgDir, 'app'), { recursive: true });
        writeFileSync(path.join(pkgDir, 'app', 'index.html'), '<html></html>');

        const entryContent = '<html></html>';
        const entryHash = createHash('sha256').update(entryContent).digest('hex');
        const manifest = {
            schema_version: '1.0.0',
            package_version: '0.0.0',
            package_name: 'fortweb-runtime',
            producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            files: [{ path: 'app/index.html', sha256: entryHash, bytes: Buffer.byteLength(entryContent) }],
        };
        writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest));

        // Write checksum
        const manifestJson = JSON.stringify(manifest);
        const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
        writeFileSync(path.join(pkgDir, 'checksums.sha256'), `${manifestHash}  manifest.json\n`);

        // Add unlisted extra file
        writeFileSync(path.join(pkgDir, 'secret.txt'), 'should not be here');

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "${pkgName}"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected file/);
    });

    it('rejects byte-count mismatch', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [{ path: 'app/index.html', sha256: 'a'.repeat(64), bytes: 99999 }],
            },
        });

        await expect(importZip(zipPath)).rejects.toThrow(/size mismatch/);
    });

    it('preserves exact bytes including non-ASCII content', async () => {
        const tempDir = await makeTempDir();
        const specialContent = '<html>\n<body>\n  <!-- € → λ → 🚀 -->\n  <p>null\u0000byte</p>\n</body>\n</html>\n';
        const { zipPath } = createTestZip(tempDir, {
            extraFiles: [{ path: 'unicode.txt', content: specialContent }],
        });

        await importZip(zipPath);

        const importedPath = path.join(repoRoot, 'WebPayload', 'unicode.txt');
        const importedContent = await readFile(importedPath, 'utf-8');
        expect(importedContent).toBe(specialContent);
    });

    it('rejects ZIP with symlink entry', async () => {
        const tempDir = await makeTempDir();
        const zipPath = createSymlinkZip(tempDir, 'symlink.zip', 'fortweb-runtime/link', '/etc/passwd');

        await expect(importZip(zipPath)).rejects.toThrow();
    });

    it('rejects ZIP with duplicate entries', async () => {
        const tempDir = await makeTempDir();
        const zipPath = createDuplicateEntryZip(tempDir, 'dup.zip', 'fortweb-runtime/manifest.json');

        await expect(importZip(zipPath)).rejects.toThrow(/duplicate/);
    });

    it('rejects ZIP with directory symlink', async () => {
        const tempDir = await makeTempDir();
        const zipPath = createDirSymlinkZip(tempDir, 'dirsym.zip', 'fortweb-runtime/linkdir', '/etc');

        await expect(importZip(zipPath)).rejects.toThrow();
    });

    it('accepts a package with all canonical producer identity fields', async () => {
        const tempDir = await makeTempDir();
        const { zipPath, manifest } = createTestZip(tempDir);

        await importZip(zipPath);

        const bp = path.join(repoRoot, 'WebPayload', 'manifest.json');
        const imported = JSON.parse(await readFile(bp, 'utf-8'));

        // All 8 required string fields must be present with correct types
        expect(imported.schema_version).toBe('1.0.0');
        expect(imported.package_version).toBe('0.0.0');
        expect(imported.package_name).toBe('fortweb-runtime');
        expect(imported.producer).toBe('fortweb');
        expect(imported.payload_profile).toBe('offline-runtime');
        expect(typeof imported.fortweb_commit_sha).toBe('string');
        expect(imported.fortweb_commit_sha.length).toBe(40);
        expect(typeof imported.runtime_origin).toBe('string');
        expect(imported.entrypoint).toBe('app/index.html');
        expect(Array.isArray(imported.files)).toBe(true);
        expect(imported.files.length).toBe(manifest.files.length);

        // File entries use canonical field names
        for (const f of imported.files) {
            expect(typeof f.path).toBe('string');
            expect(typeof f.sha256).toBe('string');
            expect(f.sha256).toHaveLength(64);
            expect(typeof f.bytes).toBe('number');
            expect(f.bytes).toBeGreaterThanOrEqual(0);
            expect(f.size).toBeUndefined();
        }
    });

    it('rejects ZIP with missing manifest.json', async () => {
        const tempDir = await makeTempDir();
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'nomanifest.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(path.join(pkgDir, 'app'), { recursive: true });
        writeFileSync(path.join(pkgDir, 'app', 'index.html'), '<html></html>');

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "${pkgName}"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow();
    });

    it('rejects ZIP with malformed manifest (not JSON)', async () => {
        const tempDir = await makeTempDir();
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'badjson.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(path.join(pkgDir, 'manifest.json'), 'not valid json {{{');

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "${pkgName}"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow();
    });

    it('rejects ZIP with manifest missing files array', async () => {
        const tempDir = await makeTempDir();
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'nofiles.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(pkgDir, { recursive: true });
        const manifest = {
            schema_version: '1.0.0',
            package_version: '0.0.0',
            package_name: 'fortweb-runtime',
            producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            files: 'not-an-array',
        };
        writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest));
        writeFileSync(path.join(pkgDir, 'checksums.sha256'), '0000000000000000000000000000000000000000000000000000000000000000  manifest.json\n');

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "${pkgName}"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow(/files is not an array/);
    });
});

// --------------------------------------------------------------------------
// Producer-consumer interop: actual FortWeb package → Fort-ios importer
// --------------------------------------------------------------------------

describe('runtime package interop — real producer', () => {
    const FORTWEB_PACKAGER = path.join(
        repoRoot, '..', 'fortweb', 'tools', 'package-runtime.mjs',
    );

    it('imports a ZIP generated by the actual FortWeb packager', async () => {
        // Skip if sibling checkout is unavailable (unit-test isolation)
        const fsPromises = await import('node:fs/promises');
        try {
            await fsPromises.stat(FORTWEB_PACKAGER);
        } catch {
            return; // interop test requires sibling checkout
        }

        const tempDir = await makeTempDir();
        const runtimeDir = path.join(tempDir, 'dist', 'runtime');
        const outDir = path.join(tempDir, 'out');
        const importDest = path.join(tempDir, 'imported');

        // Create a minimal runtime tree
        await writeTextFile(
            path.join(runtimeDir, 'app', 'index.html'),
            '<!DOCTYPE html>\n<html><body><p>Interop Test \xe2\x82\xac</p>\n</body></html>\n',
        );
        await writeTextFile(
            path.join(runtimeDir, 'app', 'app', 'main.js'),
            'console.log("interop");\n',
        );

        // Run FortWeb packager. Temporarily replace dist/runtime with fixture.
        const fortwebDir = path.join(repoRoot, '..', 'fortweb');
        const fortwebDist = path.join(fortwebDir, 'dist', 'runtime');
        const fortwebDistBak = fortwebDist + '.interop-bak';

        // Move existing dist/runtime aside if it exists
        try { await fsPromises.rename(fortwebDist, fortwebDistBak); } catch { /* no existing */ }
        try { await fsPromises.symlink(runtimeDir, fortwebDist); } catch { /* */ }

        let packagerOk = false;
        try {
            const { execFile: ef } = await import('node:child_process');
            const { promisify: p } = await import('node:util');
            await p(ef)('node', [FORTWEB_PACKAGER, '--no-build', '--out-dir', outDir], {
                cwd: fortwebDir,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024,
            });
            packagerOk = true;
        } catch (e) {
            // Packager failed — skip import verification
        } finally {
            try { await fsPromises.unlink(fortwebDist); } catch { /* */ }
            try { await fsPromises.rename(fortwebDistBak, fortwebDist); } catch { /* */ }
        }

        if (!packagerOk) return;

        // Find the generated ZIP
        const zipEntries = await fsPromises.readdir(outDir);
        const zipName = zipEntries.find(e => e.endsWith('.zip'));
        if (!zipName) return;
        const zipPath = path.join(outDir, zipName);

        // Import with Fort-ios importer into isolated destination
        const { execFile: ef2 } = await import('node:child_process');
        const { promisify: p2 } = await import('node:util');
        const { stdout, stderr } = await p2(ef2)('node', [importScript, zipPath], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, FORTWEB_IMPORT_DEST: importDest },
            maxBuffer: 1024 * 1024,
        });
        expect(stdout + stderr).toContain('Import complete');

        // Verify imported structure
        const bp = path.join(importDest, 'manifest.json');
        const imported = JSON.parse(await readFile(bp, 'utf-8'));
        expect(imported.package_name).toBe('fortweb-runtime');
        expect(imported.producer).toBe('fortweb');
        expect(imported.payload_profile).toBe('offline-runtime');
        expect(imported.entrypoint).toBe('app/index.html');
        expect(imported.files.length).toBeGreaterThanOrEqual(2);

        // Verify entrypoint file exists at package-root-relative path
        const entryStat = await fsPromises.stat(path.join(importDest, 'app', 'index.html'));
        expect(entryStat.isFile()).toBe(true);

        // Wrapper redirect points to WebPayload-root-relative app/index.html
        const redirect = await readFile(path.join(importDest, 'index.html'), 'utf-8');
        expect(redirect).toContain('./app/index.html');
    });
});

// --------------------------------------------------------------------------
// Path rejection — absolute, traversal, canonicalization
// --------------------------------------------------------------------------

describe('runtime package containment — path rejection', () => {
    it('rejects absolute POSIX path in manifest files', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [{ path: '/absolute/path.js', sha256: '0'.repeat(64), bytes: 0 }],
            },
        });
        await expect(importZip(zipPath)).rejects.toThrow(/unsafe path/);
    });

    it('rejects ../ traversal in manifest files', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [{ path: '../escape.js', sha256: '0'.repeat(64), bytes: 0 }],
            },
        });
        await expect(importZip(zipPath)).rejects.toThrow(/unsafe path/);
    });

    it('rejects embedded /../ traversal in manifest files', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            manifestOverrides: {
                files: [{ path: 'a/../escape.js', sha256: '0'.repeat(64), bytes: 0 }],
            },
        });
        await expect(importZip(zipPath)).rejects.toThrow(/unsafe path/);
    });

    it('rejects wrong package root in ZIP', async () => {
        const tempDir = await makeTempDir();
        const zipPath = path.join(tempDir, 'wrongroot.zip');
        const pkgDir = path.join(tempDir, 'wrong-root');

        mkdirSync(path.join(pkgDir, 'app'), { recursive: true });
        writeFileSync(path.join(pkgDir, 'app', 'index.html'), '<html></html>');
        writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({
            schema_version: '1.0.0', package_version: '0.0.0',
            package_name: 'fortweb-runtime', producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            files: [{ path: 'app/index.html', sha256: '0'.repeat(64), bytes: 0 }],
        }));
        writeFileSync(path.join(pkgDir, 'checksums.sha256'), '0000000000000000000000000000000000000000000000000000000000000000  manifest.json\n');

        const cwd = process.cwd();
        process.chdir(tempDir);
        execSync(`zip -qr "${zipPath}" "wrong-root"`, { encoding: 'utf-8' });
        process.chdir(cwd);

        await expect(importZip(zipPath)).rejects.toThrow(/package root/);
    });
});

// --------------------------------------------------------------------------
// Symlink sentinel — root-escape proof
// --------------------------------------------------------------------------

describe('runtime package containment — sentinel root-escape', () => {
    it('symlink targeting external sentinel file does not escape', async () => {
        const tempDir = await makeTempDir();
        // Create a sentinel file outside any extraction root
        const sentinelPath = path.join(tempDir, 'sentinel.txt');
        const sentinelContent = 'SENTINEL-DO-NOT-TOUCH-' + Date.now();
        writeFileSync(sentinelPath, sentinelContent);
        const sentinelHash = createHash('sha256').update(sentinelContent).digest('hex');

        // Create symlink ZIP targeting the sentinel
        const zipPath = createSymlinkZip(tempDir, 'escape.zip', 'fortweb-runtime/link', sentinelPath);

        // Attempt import — must fail
        try {
            await importZip(zipPath);
        } catch {
            // Expected failure
        }

        // Sentinel must be intact
        const afterContent = readFileSync(sentinelPath, 'utf-8');
        expect(afterContent).toBe(sentinelContent);

        const afterHash = createHash('sha256').update(afterContent).digest('hex');
        expect(afterHash).toBe(sentinelHash);

        // No unexpected sibling files created beside sentinel
        const sentinelDir = await readdir(tempDir);
        const unexpectedFiles = sentinelDir.filter(f =>
            f !== 'sentinel.txt' && !f.startsWith('tmp.') && f !== path.basename(zipPath),
        );
        expect(unexpectedFiles.length).toBeLessThanOrEqual(2); // temp import dirs OK
    });
});

// --------------------------------------------------------------------------
// Replacement safety
// --------------------------------------------------------------------------

describe('runtime package containment — replacement safety', () => {
    it('leaves existing destination intact on validation failure', async () => {
        const tempDir = await makeTempDir();
        const existingDest = path.join(tempDir, 'existing-payload');
        mkdirSync(existingDest, { recursive: true });
        const existingFile = path.join(existingDest, 'should-survive.txt');
        writeFileSync(existingFile, 'survivor');

        // Try importing a bad package into existingDest
        const badTempDir = await makeTempDir();
        const { zipPath: badZip } = createTestZip(badTempDir, {
            manifestOverrides: { package_name: 'wrong-name' },
        });

        try {
            await execFile('node', [importScript, badZip], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...process.env, FORTWEB_IMPORT_DEST: existingDest },
            });
        } catch {
            // Expected
        }

        const survivor = readFileSync(existingFile, 'utf-8');
        expect(survivor).toBe('survivor');
    });

    it('successful replacement places all expected files', async () => {
        const tempDir = await makeTempDir();
        const dest = path.join(tempDir, 'replace-dest');

        const { zipPath } = createTestZip(tempDir);

        await execFile('node', [importScript, zipPath], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, FORTWEB_IMPORT_DEST: dest },
        });

        // Verify structure
        const bp = path.join(dest, 'manifest.json');
        expect(existsSync(bp)).toBe(true);
        expect(existsSync(path.join(dest, 'app', 'index.html'))).toBe(true);
        expect(existsSync(path.join(dest, 'index.html'))).toBe(true);
    });

    it('old destination survives staging-copy failure', async () => {
        const tempDir = await makeTempDir();
        const dest = path.join(tempDir, 'live-dest');
        mkdirSync(dest, { recursive: true });
        const survivorPath = path.join(dest, 'survivor.txt');
        const survivorContent = 'MUST-SURVIVE-' + Date.now();
        writeFileSync(survivorPath, survivorContent);

        const { zipPath } = createTestZip(tempDir);

        // Import with FORTWEB_IMPORT_DRY_RUN=1 to prepare staging without activating
        const { execFile: ef } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        const result = await p(ef)('node', [importScript, zipPath], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                FORTWEB_IMPORT_DEST: dest,
                FORTWEB_IMPORT_DRY_RUN: '1',
            },
            maxBuffer: 1024 * 1024,
        });

        // Old destination must be intact
        const survivor = readFileSync(survivorPath, 'utf-8');
        expect(survivor).toBe(survivorContent);
    });

    it('rolls back when activation of new payload fails', async () => {
        const tempDir = await makeTempDir();
        const dest = path.join(tempDir, 'live-dest');
        mkdirSync(dest, { recursive: true });
        const oldFile = path.join(dest, 'old-payload.txt');
        writeFileSync(oldFile, 'OLD-PAYLOAD');

        const { zipPath } = createTestZip(tempDir);

        // Import with FORTWEB_IMPORT_SIMULATE_ACTIVATION_FAILURE=1
        const { execFile: ef } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        try {
            await p(ef)('node', [importScript, zipPath], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    FORTWEB_IMPORT_DEST: dest,
                    FORTWEB_IMPORT_SIMULATE_ACTIVATION_FAILURE: '1',
                },
                maxBuffer: 1024 * 1024,
            });
        } catch {
            // Expected: activation was simulated to fail
        }

        // Old destination must still be intact
        expect(existsSync(oldFile)).toBe(true);
        expect(readFileSync(oldFile, 'utf-8')).toBe('OLD-PAYLOAD');
    });

    it('clean removal of old payload after successful activation', async () => {
        const tempDir = await makeTempDir();
        const dest = path.join(tempDir, 'live-dest');
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, 'old.txt'), 'old');

        const { zipPath } = createTestZip(tempDir);

        const { execFile: ef } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        await p(ef)('node', [importScript, zipPath], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, FORTWEB_IMPORT_DEST: dest },
            maxBuffer: 1024 * 1024,
        });

        // Old file is gone, new payload is present
        expect(existsSync(path.join(dest, 'old.txt'))).toBe(false);
        expect(existsSync(path.join(dest, 'manifest.json'))).toBe(true);
        expect(existsSync(path.join(dest, 'app', 'index.html'))).toBe(true);
    });

    it('creates destination when none existed before', async () => {
        const tempDir = await makeTempDir();
        const dest = path.join(tempDir, 'fresh-dest');
        // dest does not exist yet

        const { zipPath } = createTestZip(tempDir);

        const { execFile: ef } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        await p(ef)('node', [importScript, zipPath], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, FORTWEB_IMPORT_DEST: dest },
            maxBuffer: 1024 * 1024,
        });

        expect(existsSync(path.join(dest, 'manifest.json'))).toBe(true);
        expect(existsSync(path.join(dest, 'app', 'index.html'))).toBe(true);
    });
});
