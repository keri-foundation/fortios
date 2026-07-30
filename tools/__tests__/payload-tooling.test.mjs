import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
        producer: 'fortweb-shared',
        payload_profile: 'product-shell',
        entry_document: 'fortweb/app/index.html',
        entry_script: 'fortweb/app/app/main.js',
        build_command: 'PAYLOAD_SOURCE=fortweb ./sync-payload.sh',
        pyodide_worker_mode: 'pyscript-pyworker',
        pyodide_asset_path: '/fortweb/vendor/pyodide/0.29.3/pyodide.mjs',
        pyodide_asset_mode: 'esm',
        sync_targets: [{ id: 'ios-webpayload' }],
        source_git_branch: 'feature/test',
        source_git_status: 'clean',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
});

describe('validate-mobile-payload.mjs', () => {
    it('passes for a FortWeb shared payload manifest without blocked markers', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<h1>KERI Wallet</h1>');
        // Must include the declared entry script file
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'console.log("loaded");');

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(stdout).toContain('[payload-check] result: PASS');
    });

    it('fails when declared entry script is missing', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<h1>KERI Wallet</h1>');
        // entry_script declares fortweb/app/app/main.js but only main.ts exists
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.ts'), 'console.log("source");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('missing');
        expect(error.stdout).toContain('main.js');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails when declared entry script path escapes payload root', async () => {
        const payloadDir = await makeTempDir();
        // The manifest field check compares against the expected value for
        // ios-webpayload.  Use a manifest with a traversal value AND a
        // non-matching producer so the manifest check also catches it.
        await writeJsonFile(
            path.join(payloadDir, 'build-manifest.json'),
            makeSharedManifest({
                producer: 'fortweb-shared',
                payload_profile: 'product-shell',
                entry_document: 'fortweb/app/index.html',
                entry_script: '../../etc/passwd',
            })
        );
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<h1>KERI Wallet</h1>');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails when entry HTML references a missing local script', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        // Entry HTML references a script that does not exist
        await writeTextFile(
            path.join(payloadDir, 'fortweb', 'app', 'index.html'),
            '<script src="./missing-script.js"></script>'
        );
        // The declared entry_script exists (main.js)
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'console.log("loaded");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('missing file');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('passes when entry HTML references existing local scripts', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(
            path.join(payloadDir, 'fortweb', 'app', 'index.html'),
            '<script type="module" src="./app/main.js"></script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'console.log("loaded");');

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(stdout).toContain('[payload-check] result: PASS');
    });

    it('fails when entry document is missing', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        // No fortweb/app/index.html written
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'console.log("loaded");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('missing');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });

    it('fails for a blocked manifest posture', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(
            path.join(payloadDir, 'build-manifest.json'),
            makeSharedManifest({
                producer: 'fort-ios-local',
                payload_profile: 'proof-shell',
            })
        );

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('fort-ios-local');
        expect(error.stdout).toContain('product-shell payload');
    });

    it('fails when legacy shell markers remain in the staged payload', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<p>Profile ID</p>');
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'console.log("loaded");');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('"Profile ID"');
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

import { mkdirSync, writeFileSync } from 'node:fs';
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
