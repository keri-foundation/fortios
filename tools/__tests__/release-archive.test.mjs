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

// The release assertion evaluates submission declarations as well as payload
// bytes, so the fixture has to ship the same declaration surfaces a real
// archive ships: a generated Info.plist and a bundled privacy manifest.
// FileTimestamp/C617.1 mirrors first-party usage in this repository
// (attributesOfItem in PayloadSchemeHandler.swift).
const APP_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.keri.fort.fixture</string>
  <key>CFBundleExecutable</key>
  <string>KeriWallet</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>16.4</string>
</dict>
</plist>
`;

const APP_PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>C617.1</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;

async function buildFixtureArchive() {
    const root = await makeTempDir();
    const archivePath = path.join(root, 'KeriWallet.xcarchive');
    const appPath = path.join(archivePath, 'Products', 'Applications', 'KeriWallet.app');
    const payloadRoot = path.join(appPath, 'WebPayload');
    const referenceRoot = path.join(root, 'reference-payload');

    await writeTextFile(path.join(archivePath, 'Info.plist'), APP_INFO_PLIST);
    await writeTextFile(path.join(appPath, 'Info.plist'), APP_INFO_PLIST);
    await writeTextFile(path.join(appPath, 'PrivacyInfo.xcprivacy'), APP_PRIVACY_MANIFEST);
    await writeTextFile(path.join(appPath, 'KeriWallet'), 'fake-mach-o-binary');

    await buildPayloadTree(payloadRoot);
    await buildPayloadTree(referenceRoot);

    return { root, archivePath, appPath, payloadRoot, referenceRoot };
}

async function runVerifier(archivePath, referenceRoot, extraArgs = []) {
    try {
        return await execFile('node', [
            verifierScript,
            '--archive', archivePath,
            '--reference-payload', referenceRoot,
            '--skip-delegated-validators',
            ...extraArgs,
        ], { cwd: repoRoot, encoding: 'utf8' });
    } catch (error) {
        // Attach the verifier's own report to the rejection. Otherwise a hosted
        // run reports only "Command failed" and the cause has to be reproduced
        // locally before it can be read. The original error is preserved so the
        // failure-shape assertions below can still inspect stdout and stderr.
        error.message = [error.message, error.stdout?.trimEnd(), error.stderr?.trimEnd()]
            .filter(Boolean)
            .join('\n');
        throw error;
    }
}

async function runVerifierExpectFailure(archivePath, referenceRoot, extraArgs = []) {
    try {
        await runVerifier(archivePath, referenceRoot, extraArgs);
    } catch (error) {
        return error;
    }
    throw new Error('Expected assert-release-archive.mjs to fail');
}

/**
 * Inject forbidden release content into BOTH trees so byte identity still
 * holds and only the producer-owned content gate can fire.
 */
async function injectForbiddenReleaseContent(payloadRoot, referenceRoot) {
    const injected = 'const legacy = "itms-services";\n';
    await writeTextFile(path.join(payloadRoot, 'app', 'app', 'main.js'), injected);
    await writeTextFile(path.join(referenceRoot, 'app', 'app', 'main.js'), injected);
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

    it('fails closed when the bundled privacy manifest is absent (NEGATIVE_MISSING_PRIVACY_MANIFEST)', async () => {
        const { archivePath, appPath, referenceRoot } = await buildFixtureArchive();
        await rm(path.join(appPath, 'PrivacyInfo.xcprivacy'));

        const error = await runVerifierExpectFailure(archivePath, referenceRoot);
        expect(error.stdout).toContain('privacy manifest is missing or unreadable');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
    });

    it('reports producer-owned content findings in the PR lane without enforcing them', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        await injectForbiddenReleaseContent(payloadRoot, referenceRoot);

        const { stdout } = await runVerifier(archivePath, referenceRoot);

        // The finding is still reported, never silenced — and the PR lane says
        // plainly that it did not certify anything.
        expect(stdout).toContain('release-content finding');
        expect(stdout).toContain('itms-services');
        expect(stdout).toContain('producer-owned findings not enforced in this lane');
        expect(stdout).toContain('[release-archive] result: PASS');
        expect(stdout).toContain('certification: NOT_CERTIFIED');
        expect(stdout).not.toContain('certification: CERTIFIED');
    });

    it('enforces producer-owned content findings during release certification', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        await injectForbiddenReleaseContent(payloadRoot, referenceRoot);

        const error = await runVerifierExpectFailure(archivePath, referenceRoot, ['--release-certification']);

        expect(error.stdout).toContain('lane: release-certification');
        expect(error.stdout).toContain('kind: release-content');
        expect(error.stdout).toContain('[release-archive] result: FAIL');
        expect(error.stdout).toContain('certification: NOT_CERTIFIED');
    });

    it('still enforces wrapper-owned violations during release certification', async () => {
        const { archivePath, payloadRoot, referenceRoot } = await buildFixtureArchive();
        const mainPath = path.join(payloadRoot, 'app', 'app', 'main.js');
        await writeTextFile(mainPath, 'console.log("corrupted");');

        const error = await runVerifierExpectFailure(archivePath, referenceRoot, ['--release-certification']);

        expect(error.stdout).toContain('SHA-256 mismatch');
        expect(error.stdout).toContain('certification: NOT_CERTIFIED');
    });

    it('writes release evidence naming the lane, source commit, and archive digest', async () => {
        const { root, archivePath, referenceRoot } = await buildFixtureArchive();
        const evidencePath = path.join(root, 'release-evidence.json');

        const { stdout } = await runVerifier(archivePath, referenceRoot, ['--evidence', evidencePath]);
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

        expect(stdout).toContain('evidence written');
        expect(evidence.schema).toBe('fort.ios-release-evidence.v1');
        expect(evidence.lane).toBe('pr');
        expect(evidence.result).toBe('PASS');
        expect(evidence.certified).toBe(false);
        // Null only when Git is unavailable; otherwise a full commit SHA.
        expect(evidence.sourceCommitSha === null || /^[0-9a-f]{40}$/.test(evidence.sourceCommitSha)).toBe(true);
        expect(evidence.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(evidence.archiveFileCount).toBeGreaterThan(0);
        expect(evidence.summary.bundle.fileCount).toBeGreaterThan(0);
    });
});
