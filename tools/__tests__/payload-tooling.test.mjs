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

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(stdout).toContain('[payload-check] result: PASS');
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
