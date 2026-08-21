import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const verifierScript = path.join(repoRoot, 'tools', 'assert-release-archive.mjs');

const tempDirs = [];

async function makeTempDir() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-release-archive-'));
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

function buildPayloadTree(root) {
    const manifest = {
        schema_version: '1.0.0',
        package_name: 'fortweb-runtime',
        producer: 'fortweb',
        payload_profile: 'offline-runtime',
        entrypoint: 'app/index.html',
        contracts: {
            runtime_requirements: { path: 'contracts/runtime-requirements.json' },
        },
    };
    return Promise.all([
        writeJsonFile(path.join(root, 'manifest.json'), manifest),
        writeTextFile(path.join(root, 'index.html'), '<!DOCTYPE html><html><body>redirect</body></html>\n'),
        writeTextFile(path.join(root, 'app', 'index.html'), '<h1>FortWeb</h1>'),
        writeTextFile(path.join(root, 'app', 'app', 'main.js'), 'console.log("runtime");'),
        writeJsonFile(path.join(root, 'contracts', 'runtime-requirements.json'), {
            schema: 'fort.runtime-requirements.v1',
            version: 1,
        }),
    ]);
}

async function buildFixtureArchive() {
    const root = await makeTempDir();
    const archivePath = path.join(root, 'KeriWallet.xcarchive');
    const appPath = path.join(archivePath, 'Products', 'Applications', 'KeriWallet.app');
    const payloadRoot = path.join(appPath, 'WebPayload');
    const referenceRoot = path.join(root, 'reference-payload');

    await writeTextFile(path.join(archivePath, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"></plist>\n');
    await writeTextFile(path.join(appPath, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"></plist>\n');
    await writeTextFile(path.join(appPath, 'KeriWallet'), 'fake-mach-o-binary');

    await buildPayloadTree(payloadRoot);
    await buildPayloadTree(referenceRoot);

    return { root, archivePath, appPath, payloadRoot, referenceRoot };
}

async function runVerifier(archivePath, referenceRoot) {
    return execFile('node', [
        verifierScript,
        '--archive', archivePath,
        '--reference-payload', referenceRoot,
        '--skip-delegated-validators',
    ], { cwd: repoRoot, encoding: 'utf8' });
}

async function runVerifierExpectFailure(archivePath, referenceRoot) {
    try {
        await runVerifier(archivePath, referenceRoot);
    } catch (error) {
        return error;
    }
    throw new Error('Expected assert-release-archive.mjs to fail');
}

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
});

describe('assert-release-archive.mjs', () => {
    it('passes for a clean archive with byte-identical payload', async () => {
        const { archivePath, referenceRoot } = await buildFixtureArchive();
        const { stdout } = await runVerifier(archivePath, referenceRoot);
        expect(stdout).toContain('[release-archive] result: PASS');
        expect(stdout).toContain('byte identity validated: true');
        expect(stdout).toContain('sanitization passed: true');
    });

    it('fails closed when a manifest-owned runtime file is missing (NEGATIVE_MISSING_FILE)', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        await rm(path.join(payloadRoot, 'app', 'app', 'main.js'));

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('file missing from archived payload');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });

    it('fails closed when a runtime file byte is mutated (NEGATIVE_MUTATED_FILE)', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        const mainPath = path.join(payloadRoot, 'app', 'app', 'main.js');
        await writeTextFile(mainPath, 'console.log("corrupted");');

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('SHA-256 mismatch');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });

    it('fails closed when a forbidden development artifact is injected (NEGATIVE_FORBIDDEN_FILE)', async () => {
        const { archivePath, appPath, referenceRoot } = await buildFixtureArchive();
        await writeTextFile(path.join(appPath, 'debug.map'), '{}');

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('unexpected bundle entry');
        expect(error.stdout).toContain('debug.map');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });

    it('fails closed on a contract schema mismatch (NEGATIVE_CONTRACT_MISMATCH)', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        // Corrupt the contract in BOTH trees identically so byte identity passes,
        // but the verifier's own structural contract check fails.
        const badContract = { schema: 'fort.runtime-requirements.v0', version: 1 };
        await writeJsonFile(path.join(payloadRoot, 'contracts', 'runtime-requirements.json'), badContract);
        await writeJsonFile(path.join(referenceRoot, 'contracts', 'runtime-requirements.json'), badContract);

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('contract schema mismatch');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });

    it('fails closed when the archived payload contains a symlink', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        const target = path.join(payloadRoot, 'app', 'app', 'main.js');
        const linkPath = path.join(payloadRoot, 'app', 'app', 'extra.js');
        await symlink('main.js', linkPath);
        expect((await readFile(target, 'utf8')).length).toBeGreaterThan(0); // target still present

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('unexpected symlink in archived payload');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });
});
