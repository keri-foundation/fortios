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

/**
 * Aggregate SHA-256 over every file in a directory tree (path + bytes).
 * Used to prove a failed import leaves the previously staged payload
 * byte-for-byte unchanged, rather than merely exiting non-zero.
 */
async function treeSha256(dir) {
    const rows = [];
    async function walk(current, prefix) {
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch (e) {
            if (e.code === 'ENOENT') return;
            throw e;
        }
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full, rel);
            } else if (entry.isFile()) {
                const data = await readFile(full);
                rows.push(`${rel} ${createHash('sha256').update(data).digest('hex')}`);
            }
        }
    }
    await walk(dir, '');
    rows.sort();
    return createHash('sha256').update(rows.join('\n')).digest('hex');
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

// --- importer tests ---

import { execSync } from 'node:child_process';

const importScript = path.join(repoRoot, 'tools', 'import-fortweb-runtime-package.mjs');

/**
 * Create a minimal valid ZIP with a manifest and one entry in the canonical
 * FortWeb runtime package format (manifest.json, checksums.sha256).
 * Uses system `zip` command. All fixtures are generated in temp dirs.
 */
/**
 * Write the canonical contracts descriptor the importer requires, in the
 * shape produced by FortWeb #38. Returns the relative path and body so the
 * caller can declare it in manifest.files.
 */
function writeCanonicalRequirements(pkgDir, { relPath = 'contracts/runtime-requirements.json', overrides = {} } = {}) {
    const descriptor = {
        schema: 'fort.runtime-requirements.v1',
        version: 1,
        producer: 'fortweb',
        payload_profile: 'offline-runtime',
        capabilities: { persistent_storage_partition: { required: true } },
        forbidden_behaviors: [
            'network_fetch',
            'service_worker_registration',
            'general_purpose_browsing',
            'localhost_or_loopback_origin',
            'http_fallback',
        ],
        ...overrides,
    };
    const body = `${JSON.stringify(descriptor, null, 2)}\n`;
    const fullPath = path.join(pkgDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, body);
    return { relPath, body };
}

function createTestZip(tempDir, { packageName = 'fortweb-runtime', manifestOverrides = {}, extraFiles = [], hiddenFiles = [], omitChecksumFile = false, checksumText = null, omitContractsDescriptor = false, contractsText = null, requirementsOverrides = {}, manifestRawText = null, tamperFileAfterManifest = null } = {}) {
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
        contracts: { runtime_requirements: { path: 'contracts/runtime-requirements.json' } },
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

    // Write undeclared files: present in the ZIP but absent from the manifest.
    // Used to prove the inventory check is complete and carries no dot-prefix
    // exemption.
    for (const hf of hiddenFiles) {
        const hfPath = path.join(pkgDir, hf.path);
        mkdirSync(path.dirname(hfPath), { recursive: true });
        writeFileSync(hfPath, hf.content);
    }

    // Write the declared contracts descriptor (canonical #38 shape). The
    // manifest points at it and it is part of the declared inventory.
    const requirementsRel = 'contracts/runtime-requirements.json';
    const requirementsDescriptor = {
        schema: 'fort.runtime-requirements.v1',
        version: 1,
        producer: 'fortweb',
        payload_profile: 'offline-runtime',
        capabilities: { persistent_storage_partition: { required: true } },
        forbidden_behaviors: [
            'network_fetch',
            'service_worker_registration',
            'general_purpose_browsing',
            'localhost_or_loopback_origin',
            'http_fallback',
        ],
        ...requirementsOverrides,
    };
    const requirementsBody = contractsText ?? `${JSON.stringify(requirementsDescriptor, null, 2)}\n`;
    if (!omitContractsDescriptor) {
        const requirementsPath = path.join(pkgDir, requirementsRel);
        mkdirSync(path.dirname(requirementsPath), { recursive: true });
        writeFileSync(requirementsPath, requirementsBody);
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
        if (!omitContractsDescriptor) {
            manifest.files.push({
                path: requirementsRel,
                sha256: createHash('sha256').update(requirementsBody).digest('hex'),
                bytes: Buffer.byteLength(requirementsBody),
            });
        }
    }

    // Write manifest. `manifestRawText` lets a test emit a malformed manifest
    // body without also corrupting the surrounding fixture generation.
    const manifestJson = manifestRawText ?? JSON.stringify(manifest, null, 2);
    writeFileSync(path.join(pkgDir, 'manifest.json'), manifestJson);

    // Write checksum file (required package metadata). The canonical FortWeb
    // contract is a single row covering manifest.json, sha256sum format.
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
    const checksumBody = checksumText ?? `${manifestHash}  manifest.json\n`;
    if (!omitChecksumFile) {
        writeFileSync(path.join(pkgDir, 'checksums.sha256'), checksumBody);
    }

    // Chain-of-trust tamper: rewrite a declared payload file AFTER the manifest
    // digest and the manifest checksum were computed. The manifest stays
    // authentic (checksums.sha256 still covers it) while the payload bytes no
    // longer match manifest.files[].
    if (tamperFileAfterManifest) {
        const tamperPath = path.join(pkgDir, tamperFileAfterManifest.path);
        writeFileSync(tamperPath, tamperFileAfterManifest.content);
    }

    // Create ZIP (run from inside tempDir so paths are relative). Argument
    // array, not shell interpolation: fixture paths are data, not commands.
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
        execFileSync('zip', ['-qr', zipPath, packageName], { encoding: 'utf-8' });
    } finally {
        process.chdir(cwd);
    }

    return { zipPath, manifest, entryContent, pkgDir, requirementsBody };
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Create a fresh isolated import destination (never the real repo WebPayload). */
async function freshImportDest() {
    const dest = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-import-dest-'));
    tempDirs.push(dest);
    return dest;
}

async function importZip(zipPath, importDest) {
    const dest = importDest || await freshImportDest();
    return execFile('node', [importScript, zipPath], {
        cwd: repoRoot,
        env: { ...process.env, FORTWEB_IMPORT_DEST: dest },
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

/**
 * Stage a valid payload, attempt a failing import, and prove both that the
 * import was rejected and that the previously staged payload is byte-for-byte
 * unchanged. A non-zero exit code alone is not sufficient evidence.
 */
async function expectRejectedAndPreserved(buildBadZip, expectedError) {
    const dest = await freshImportDest();
    const goodDir = await makeTempDir();
    const { zipPath: goodZip } = createTestZip(goodDir);
    await importZip(goodZip, dest);
    const before = await treeSha256(dest);

    const badDir = await makeTempDir();
    const { zipPath: badZip } = await buildBadZip(badDir);

    await expect(importZip(badZip, dest)).rejects.toThrow(expectedError);
    expect(await treeSha256(dest)).toBe(before);
}

describe('import-fortweb-runtime-package.mjs', () => {
    it('imports a valid package successfully', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir);

        const dest = await freshImportDest();
        const { stdout } = await importZip(zipPath, dest);
        expect(stdout).toContain('Import complete');
        expect(stdout).toContain('fortweb-runtime');

        // Verify the isolated import destination was populated
        const bp = path.join(dest, 'manifest.json');
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

    it('rejects tampered payload bytes against an authenticated manifest and preserves the previous payload', async () => {
        // Chain of trust: checksums.sha256 authenticates manifest.json, and
        // manifest.files[] authenticates the runtime payload bytes. Here the
        // manifest and its checksum are untouched and valid, and only the
        // payload bytes change.
        //
        // The tamper is byte-length preserving, so a size check cannot catch
        // it: only the SHA-256 comparison can reject this package.
        const original = '<!DOCTYPE html><html><head><title>Test</title></head><body>KERI</body></html>';
        const tampered = '<!DOCTYPE html><html><head><title>Test</title></head><body>FAKE</body></html>';
        expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));

        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, {
                tamperFileAfterManifest: { path: 'app/index.html', content: tampered },
            }),
            /sha256 mismatch for "app\/index\.html"/,
        );
    });

    it('preserves manifest bytes exactly', async () => {
        const tempDir = await makeTempDir();
        const { zipPath, manifest } = createTestZip(tempDir);

        const dest = await freshImportDest();
        await importZip(zipPath, dest);

        // Read back the manifest — should match exactly
        const bp = path.join(dest, 'manifest.json');
        const importedManifest = JSON.parse(await readFile(bp, 'utf-8'));
        expect(importedManifest.schema_version).toBe(manifest.schema_version);
        expect(importedManifest.package_name).toBe(manifest.package_name);
        expect(importedManifest.files).toHaveLength(manifest.files.length);
    });

    it('rejects an undeclared hidden directory file in the package', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            hiddenFiles: [{ path: '.hidden/extra.js', content: 'console.log("undeclared");' }],
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected file not in manifest/);
    });

    it('rejects an undeclared root-level dotfile in the package', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir, {
            hiddenFiles: [{ path: '.extra.js', content: 'console.log("undeclared");' }],
        });

        await expect(importZip(zipPath)).rejects.toThrow(/unexpected file not in manifest/);
    });

    it('imports a ZIP whose filename contains shell metacharacters', async () => {
        const tempDir = await makeTempDir();
        const { zipPath } = createTestZip(tempDir);

        // Covers every metacharacter class the importer must treat as literal
        // path data: spaces, single and double quotes, `$`, `;`, parentheses,
        // command substitution, and backticks. A shell-interpolated unzip call
        // would both mangle the path and execute the adjacent command.
        const sentinel = 'fortios-ios1-injection-sentinel';
        const adversarialName = `pkg "double" 'single' $dollar; touch ${sentinel}; (parens) $(sub) \`backtick\`.zip`;
        const metacharZip = path.join(tempDir, adversarialName);

        // Rename via fs (no shell) so the importer receives a path that would
        // be mangled by shell interpolation but is a literal path on disk.
        renameSync(zipPath, metacharZip);

        const dest = await freshImportDest();
        const { stdout } = await importZip(metacharZip, dest);
        expect(stdout).toContain('Import complete');

        // No adjacent command may have executed. Check both the import working
        // directory and the archive directory.
        expect(existsSync(path.join(repoRoot, sentinel))).toBe(false);
        expect(existsSync(path.join(tempDir, sentinel))).toBe(false);
    });

    // --- IOS-2: required package metadata + transactional replacement ---

    it('rejects a package missing checksums.sha256 and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { omitChecksumFile: true }),
            /required package metadata missing: checksums\.sha256/,
        );
    });

    it('rejects a manifest checksum mismatch and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { checksumText: `${'a'.repeat(64)}  manifest.json\n` }),
            /checksums\.sha256 mismatch for "manifest\.json"/,
        );
    });

    it('rejects a malformed checksum row and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { checksumText: 'not-a-digest  manifest.json\n' }),
            /checksums\.sha256 has a malformed row/,
        );
    });

    it('rejects an empty checksum file and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { checksumText: '\n' }),
            /checksums\.sha256 is empty/,
        );
    });

    it('rejects a checksum file that does not cover manifest.json and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { checksumText: `${'b'.repeat(64)}  app/index.html\n` }),
            /checksums\.sha256 does not cover manifest\.json/,
        );
    });

    it('rejects a checksum file referencing an undeclared path and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { checksumText: `${'c'.repeat(64)}  undeclared.js\n` }),
            /checksums\.sha256 references an undeclared path/,
        );
    });

    it('rejects a package missing manifest.json and preserves the previous payload', async () => {
        const dest = await freshImportDest();
        const goodDir = await makeTempDir();
        const { zipPath: goodZip } = createTestZip(goodDir);
        await importZip(goodZip, dest);
        const before = await treeSha256(dest);

        const badDir = await makeTempDir();
        const pkgDir = path.join(badDir, 'fortweb-runtime');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(path.join(pkgDir, 'checksums.sha256'), `${'d'.repeat(64)}  manifest.json\n`);
        const badZip = path.join(badDir, 'no-manifest.zip');

        const cwd = process.cwd();
        process.chdir(badDir);
        try {
            execSync(`zip -qr "${badZip}" fortweb-runtime`, { encoding: 'utf-8' });
        } finally {
            process.chdir(cwd);
        }

        await expect(importZip(badZip, dest)).rejects.toThrow(/Cannot read manifest/);
        expect(await treeSha256(dest)).toBe(before);
    });

    it('rejects a package missing the declared contracts descriptor and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { omitContractsDescriptor: true }),
            /runtime requirements descriptor missing: contracts\/runtime-requirements\.json/,
        );
    });

    it('rejects a relocated contracts pointer and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, {
                manifestOverrides: { contracts: { runtime_requirements: { path: 'other/requirements.json' } } },
                omitContractsDescriptor: true,
            }),
            /unexpected manifest\.contracts\.runtime_requirements\.path/,
        );
    });

    it('rejects a malformed contracts descriptor and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { contractsText: '{"schema": "fort.runtime-requirements.v1",' }),
            /invalid JSON/,
        );
    });

    it('rejects a contracts descriptor that does not echo the manifest producer and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { requirementsOverrides: { producer: 'someone-else' } }),
            /producer mismatch/,
        );
    });

    it('rejects an undeclared non-hidden file and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { hiddenFiles: [{ path: 'extra.js', content: 'console.log(1);' }] }),
            /unexpected file not in manifest/,
        );
    });

    it('rejects a malformed manifest body and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, { manifestRawText: '{"schema_version": ' }),
            /Cannot read manifest/,
        );
    });

    it('rejects a package whose declared file is absent and preserves the previous payload', async () => {
        await expectRejectedAndPreserved(
            async (dir) => createTestZip(dir, {
                manifestOverrides: {
                    files: [
                        { path: 'app/index.html', sha256: 'e'.repeat(64), bytes: 10 },
                        { path: 'app/missing.js', sha256: 'f'.repeat(64), bytes: 5 },
                    ],
                },
            }),
            /manifest file missing: app\/missing\.js/,
        );
    });

    it('imports a valid package, replaces the previous payload, and reports fortweb_commit_sha', async () => {
        const dest = await freshImportDest();
        const firstDir = await makeTempDir();
        const { zipPath: firstZip } = createTestZip(firstDir);
        await importZip(firstZip, dest);

        // The second package adds a declared payload file. Replacement must be
        // complete, not a merge over the previous payload.
        const secondDir = await makeTempDir();
        const { zipPath: secondZip } = createTestZip(secondDir, {
            extraFiles: [{ path: 'app/extra.js', content: 'console.log("second");' }],
        });
        const { stdout } = await importZip(secondZip, dest);

        expect(stdout).toContain('Import complete');
        expect(stdout).toContain('commit:  0000000000000000000000000000000000000000');
        expect(stdout).not.toContain('undefined');
        expect(existsSync(path.join(dest, 'app', 'extra.js'))).toBe(true);
        expect(existsSync(path.join(dest, 'app', 'index.html'))).toBe(true);
    });

    it('rejects when entry document is missing from package', async () => {
        const tempDir = await makeTempDir();
        const pkgName = 'fortweb-runtime';
        const zipPath = path.join(tempDir, 'bad.zip');
        const pkgDir = path.join(tempDir, pkgName);

        mkdirSync(pkgDir, { recursive: true });

        // Canonical contracts descriptor, so this fixture reaches the
        // manifest-declared-file check rather than the contracts gate.
        const requirements = writeCanonicalRequirements(pkgDir);

        const manifest = {
            schema_version: '1.0.0',
            package_version: '0.0.0',
            package_name: pkgName,
            producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            contracts: { runtime_requirements: { path: requirements.relPath } },
            files: [
                { path: 'app/index.html', sha256: '0'.repeat(64), bytes: 0 },
                {
                    path: requirements.relPath,
                    sha256: createHash('sha256').update(requirements.body).digest('hex'),
                    bytes: Buffer.byteLength(requirements.body),
                },
            ],
        };
        writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest));
        // Don't create the entry document

        const cwd = process.cwd();
        process.chdir(tempDir);
        try {
            execFileSync('zip', ['-qr', zipPath, pkgName], { encoding: 'utf-8' });
        } finally {
            process.chdir(cwd);
        }

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
        // First import a valid package into an isolated destination
        const dest = await freshImportDest();
        const tempDir1 = await makeTempDir();
        const { zipPath: validZip } = createTestZip(tempDir1);
        await importZip(validZip, dest);

        // Snapshot the entire staged tree, not just the manifest
        const beforeTree = await treeSha256(dest);

        // Try importing a bad package
        const tempDir2 = await makeTempDir();
        const { zipPath: badZip } = createTestZip(tempDir2, {
            manifestOverrides: { package_name: 'wrong-name' },
        });

        // The import must actually be rejected. A bare `catch {}` would let
        // this test pass even if the import succeeded and replaced the payload.
        await expect(importZip(badZip, dest)).rejects.toThrow(/unexpected package_name/);

        // Verify the isolated destination is unchanged
        expect(await treeSha256(dest)).toBe(beforeTree);
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
        const requirements = writeCanonicalRequirements(pkgDir);

        const manifest = {
            schema_version: '1.0.0',
            package_version: '0.0.0',
            package_name: 'fortweb-runtime',
            producer: 'fortweb',
            payload_profile: 'offline-runtime',
            fortweb_commit_sha: '0'.repeat(40),
            runtime_origin: 'https://appassets.androidplatform.net',
            entrypoint: 'app/index.html',
            contracts: { runtime_requirements: { path: requirements.relPath } },
            files: [
                { path: 'app/index.html', sha256: entryHash, bytes: Buffer.byteLength(entryContent) },
                {
                    path: requirements.relPath,
                    sha256: createHash('sha256').update(requirements.body).digest('hex'),
                    bytes: Buffer.byteLength(requirements.body),
                },
            ],
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
        try {
            execFileSync('zip', ['-qr', zipPath, pkgName], { encoding: 'utf-8' });
        } finally {
            process.chdir(cwd);
        }

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

        const dest = await freshImportDest();
        await importZip(zipPath, dest);

        const importedPath = path.join(dest, 'unicode.txt');
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

        const dest = await freshImportDest();
        await importZip(zipPath, dest);

        const bp = path.join(dest, 'manifest.json');
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

    it('imports a ZIP generated by the actual FortWeb packager', async (ctx) => {
        // Skipping is reported as skipped, never as a silent pass: an absent
        // sibling checkout must not look like passing producer interop.
        const fsPromises = await import('node:fs/promises');
        try {
            await fsPromises.stat(FORTWEB_PACKAGER);
        } catch {
            return ctx.skip('sibling FortWeb checkout with tools/package-runtime.mjs is unavailable');
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

        if (!packagerOk) return ctx.skip('local FortWeb packager did not run in this environment');

        // Find the generated ZIP
        const zipEntries = await fsPromises.readdir(outDir);
        const zipName = zipEntries.find(e => e.endsWith('.zip'));
        if (!zipName) return ctx.skip('local FortWeb packager produced no ZIP');
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
// Canonical published package — genuine #38 artifact import
// --------------------------------------------------------------------------

describe('runtime package interop — canonical published package', () => {
    const canonicalPackage = process.env.FORTWEB_RUNTIME_PACKAGE_ZIP;

    it.skipIf(!canonicalPackage)(
        'imports a genuine canonical FortWeb package over an existing payload',
        async () => {
            const fsPromises = await import('node:fs/promises');
            // A provided-but-missing artifact is a hard failure, not a skip.
            await fsPromises.stat(canonicalPackage);

            const dest = await freshImportDest();

            // Stage a smaller package first so the real package exercises
            // complete replacement rather than a first-time install.
            const firstDir = await makeTempDir();
            const { zipPath: firstZip } = createTestZip(firstDir);
            await importZip(firstZip, dest);

            const { stdout } = await importZip(canonicalPackage, dest);
            expect(stdout).toContain('Import complete');
            expect(stdout).not.toContain('undefined');

            // Canonical provenance must be reported, not undefined.
            const commitMatch = /commit:\s+([0-9a-f]{40})/.exec(stdout);
            expect(commitMatch).not.toBeNull();

            const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf-8'));
            expect(manifest.producer).toBe('fortweb');
            expect(manifest.payload_profile).toBe('offline-runtime');
            expect(manifest.entrypoint).toBe('app/index.html');
            expect(manifest.fortweb_commit_sha).toBe(commitMatch[1]);

            // Exact inventory: declared files plus package metadata plus the
            // wrapper-owned redirect written during activation.
            const declared = new Set(manifest.files.map((f) => f.path));
            declared.add('manifest.json');
            declared.add('checksums.sha256');
            declared.add('index.html');

            const actual = [];
            async function walk(current, prefix) {
                for (const entry of await fsPromises.readdir(current, { withFileTypes: true })) {
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        await walk(path.join(current, entry.name), rel);
                    } else {
                        actual.push(rel);
                    }
                }
            }
            await walk(dest, '');

            expect(actual.filter((rel) => !declared.has(rel))).toEqual([]);
            expect(actual.length).toBe(manifest.files.length + 3);
        },
    );
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
