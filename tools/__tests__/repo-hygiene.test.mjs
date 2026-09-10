import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const validatorScript = path.join(repoRoot, 'tools', 'assert-repo-hygiene.mjs');
const policyPath = path.join(repoRoot, 'tools', 'release-sanitization-policy.json');

const tempDirs = [];

const PRIVATE_KEY_MARKER = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n';

/**
 * Synthetic Git repositories: the tracked-file boundary is only meaningful if a
 * force-added artifact is caught, and proving that must never require adding
 * cruft to the real repository.
 */
async function makeRepo() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-repo-hygiene-'));
    tempDirs.push(root);
    await execFile('git', ['init', '--quiet', root]);
    await write(path.join(root, '.gitignore'), 'build/\n');
    return root;
}

async function write(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

async function gitStage(root, ...relativePaths) {
    await execFile('git', ['-C', root, 'add', '--force', '--', ...relativePaths]);
}

/** Track files without --force, so .gitignore decides what actually lands. */
async function gitStageRespectingIgnores(root, ...relativePaths) {
    await execFile('git', ['-C', root, 'add', '--', ...relativePaths]);
}

async function runValidator(root, extraArgs = []) {
    try {
        const { stdout } = await execFile('node', [validatorScript, '--root', root, '--policy', policyPath, ...extraArgs], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        return { code: 0, stdout };
    } catch (error) {
        return { code: error.code ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('repository hygiene boundary', () => {
    it('passes when generated output exists but is not tracked', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'build', 'DerivedData', 'artifact.o'), 'compiled output');
        await gitStageRespectingIgnores(root, '.');

        const result = await runValidator(root);

        // .gitignore is tracked; the ignored build output is not, and the
        // validator never inspects untracked working-tree files.
        expect(result.stdout).toContain('tracked files checked: 1');
        expect(result.stdout).not.toContain('artifact.o');
        expect(result.stdout).toContain('[repo-hygiene] result: PASS');
        expect(result.code).toBe(0);
    });

    it('fails when a generated artifact is force-added past .gitignore', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'build', 'DerivedData', 'artifact.o'), 'compiled output');
        await gitStage(root, 'build/DerivedData/artifact.o');

        const result = await runValidator(root);

        expect(result.stdout).toContain('forbidden_tracked_path');
        expect(result.stdout).toContain('build/DerivedData/artifact.o');
        expect(result.stdout).toContain('[repo-hygiene] result: FAIL');
        expect(result.code).toBe(1);
    });

    it('fails when a tracked archive or device build product is committed', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'release', 'KeriWallet.xcarchive', 'Info.plist'), '<plist/>');
        await write(path.join(root, 'release', 'KeriWallet.ipa'), 'binary');
        await write(path.join(root, 'KeriWallet.xcodeproj', 'xcuserdata', 'jay.xcuserdatad', 'UserInterfaceState.xcuserstate'), 'state');
        await gitStage(root, '.');

        const result = await runValidator(root);

        expect(result.stdout).toContain('release/KeriWallet.xcarchive/Info.plist');
        expect(result.stdout).toContain('release/KeriWallet.ipa');
        expect(result.stdout).toContain('KeriWallet.xcodeproj/xcuserdata/jay.xcuserdatad/UserInterfaceState.xcuserstate');
        expect(result.code).toBe(1);
    });

    it('catches a root-level log file even though the pattern is directory-scoped', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'xcodebuild.log'), 'build log');
        await gitStage(root, 'xcodebuild.log');

        const result = await runValidator(root);

        expect(result.stdout).toContain('forbidden_tracked_path');
        expect(result.stdout).toContain('xcodebuild.log');
        expect(result.code).toBe(1);
    });

    it('fails when a .env file is tracked', async () => {
        const root = await makeRepo();
        await write(path.join(root, '.env'), 'API_KEY=not-a-real-secret\n');
        await gitStage(root, '.env');

        const result = await runValidator(root);

        expect(result.stdout).toContain('forbidden_tracked_name');
        expect(result.stdout).toContain('.env');
        expect(result.code).toBe(1);
    });

    it('fails when private key material is tracked', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'deploy', 'signing-key.pem'), PRIVATE_KEY_MARKER);
        await gitStage(root, 'deploy/signing-key.pem');

        const result = await runValidator(root);

        expect(result.stdout).toContain('tracked_secret_content');
        expect(result.stdout).toContain('deploy/signing-key.pem');
        expect(result.code).toBe(1);
    });

    it('fails when a provisioning credential bundle is tracked', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'certs', 'distribution.p12'), 'binary-placeholder');
        await gitStage(root, 'certs/distribution.p12');

        const result = await runValidator(root);

        expect(result.stdout).toContain('forbidden_tracked_name');
        expect(result.stdout).toContain('certs/distribution.p12');
        expect(result.code).toBe(1);
    });

    it('passes for legitimate tracked sources, policies, fixtures, and templates', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'KeriWallet', 'PrivacyInfo.xcprivacy'), '<plist version="1.0"><dict/></plist>');
        await write(path.join(root, 'tools', 'release-sanitization-policy.json'), '{\n  "schema": "x"\n}\n');
        await write(path.join(root, 'tools', '__tests__', 'fixtures', 'marker-sample.txt'), PRIVATE_KEY_MARKER);
        await write(path.join(root, '.env.example'), 'API_KEY=\n');
        await write(path.join(root, 'KeriWallet', 'App.swift'), 'import Foundation\n');
        await gitStage(root, '.');

        const result = await runValidator(root);

        // Five legitimate sources plus the tracked .gitignore itself.
        expect(result.stdout).toContain('tracked files checked: 6');
        expect(result.stdout).toContain('[repo-hygiene] result: PASS');
        expect(result.code).toBe(0);
    });

    it('fails closed when the target is not a Git work tree', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-not-a-repo-'));
        tempDirs.push(root);

        const result = await runValidator(root);

        expect(result.stdout).toContain('TOOL ERROR');
        expect(result.stdout).toContain('not a Git work tree');
        expect(result.code).toBe(2);
    });

    it('writes a machine-readable report when asked', async () => {
        const root = await makeRepo();
        await write(path.join(root, 'build', 'stale.txt'), 'stale');
        await gitStage(root, 'build/stale.txt');
        const jsonPath = path.join(root, 'report.json');

        const result = await runValidator(root, ['--json', jsonPath]);
        const report = JSON.parse(await readFile(jsonPath, 'utf8'));

        expect(result.code).toBe(1);
        expect(report.schema).toBe('fort.ios-repo-hygiene-report.v1');
        expect(report.result).toBe('FAIL');
        expect(report.findings.map((finding) => finding.path)).toContain('build/stale.txt');
    });
});

describe('repository hygiene policy', () => {
    it('keeps the real tracked tree clean', async () => {
        const result = await runValidator(repoRoot);

        expect(result.stdout).toContain('[repo-hygiene] result: PASS');
        expect(result.code).toBe(0);
    });

    it('scopes every secret-content exception to a written reason', async () => {
        const policy = JSON.parse(await readFile(policyPath, 'utf8'));
        const exceptions = policy.repo_hygiene?.secret_content?.exceptions ?? [];

        expect(exceptions.length).toBeGreaterThan(0);
        for (const exception of exceptions) {
            expect(typeof exception.pattern).toBe('string');
            expect(exception.reason, `${exception.pattern} must carry a reason`).toBeTruthy();
            expect(exception.reason.length).toBeGreaterThan(20);
        }
    });
});
