import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateEntitlementXml, inspectBundle, loadPolicySections } from '../bundle-hygiene.mjs';

/**
 * Structural bundle hygiene regressions.
 *
 * Each fixture isolates ONE boundary, and each assertion checks the invariant
 * that fired so an unrelated finding cannot make a test pass.
 */

const basePolicy = loadPolicySections();

const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x00]);
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n';

async function makeApp() {
    const root = await mkdtemp(path.join(tmpdir(), 'fort-hygiene-'));
    const app = path.join(root, 'KeriWallet.app');
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    writeFileSync(path.join(app, 'KeriWallet'), MACHO_MAGIC);
    chmodSync(path.join(app, 'KeriWallet'), 0o755);
    return app;
}

function addFile(app, relPath, contents = 'x') {
    const full = path.join(app, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    return full;
}

function invariants(result) {
    return [...result.findings, ...result.errors].map((entry) => entry.invariant);
}

async function inspect(app, overrides = {}) {
    return inspectBundle(app, { policy: { ...basePolicy, ...overrides } });
}

describe('bundle hygiene — cruft paths', () => {
    it('passes a clean bundle', async () => {
        const app = await makeApp();
        addFile(app, 'PrivacyInfo.xcprivacy', '<plist/>');
        addFile(app, 'Base.lproj/Main.storyboardc/Info.plist', '<plist/>');

        const result = await inspect(app);

        expect(result.findings).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it.each([
        ['.git/config', 'bundle_hygiene'],
        ['node_modules/left-pad/index.js', 'bundle_hygiene'],
        ['.env', 'bundle_hygiene'],
        ['debug.log', 'bundle_hygiene'],
        ['backup.orig', 'bundle_hygiene'],
        ['.DS_Store', 'bundle_hygiene'],
    ])('rejects cruft path %s', async (relPath, invariant) => {
        const app = await makeApp();
        addFile(app, relPath);

        const result = await inspect(app);

        expect(invariants(result)).toContain(invariant);
        expect(result.findings.map((f) => f.path)).toContain(relPath);
    });

    it('does not apply cruft rules to canonical runtime content', async () => {
        const app = await makeApp();
        // The canonical runtime legitimately ships fixtures and tests-like paths.
        addFile(app, 'WebPayload/app/fixtures/data.js', 'export const x = 1;');

        const result = await inspect(app);

        expect(result.findings).toEqual([]);
    });

    it('cruft rule is what rejects the fixture (non-vacuity)', async () => {
        const app = await makeApp();
        addFile(app, 'coverage/report.html', '<html></html>');

        const strict = await inspect(app);
        expect(strict.findings.map((f) => f.invariant)).toContain('bundle_hygiene');

        // Relax only the cruft boundary: the same bundle is otherwise untouched,
        // so any remaining findings must come from a different boundary.
        const relaxed = await inspect(app, {
            bundle_hygiene: { ...basePolicy.bundle_hygiene, forbidden_file_names: [], forbidden_path_segments: [] },
        });
        expect(relaxed.findings.map((f) => f.invariant)).not.toContain('bundle_hygiene');
    });
});

describe('bundle hygiene — nested archive allowlist', () => {
    it('accepts the approved canonical stdlib archive', async () => {
        const app = await makeApp();
        const zipPath = path.join(app, 'WebPayload/vendor/pyodide/314.0.5/python_stdlib.zip');
        mkdirSync(path.dirname(zipPath), { recursive: true });
        mkdirSync(path.join(app, 'staging'), { recursive: true });
        writeFileSync(path.join(app, 'staging/parse.py'), 'SCHEMES = {}\n');
        execFileSync('zip', ['-qr', zipPath, '.'], { cwd: path.join(app, 'staging'), encoding: 'utf8' });

        const result = await inspect(app);

        expect(result.findings).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it('rejects an unknown nested archive', async () => {
        const app = await makeApp();
        addFile(app, 'extra.zip', 'not really a zip');

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('nested_archives');
        expect(result.findings.find((f) => f.invariant === 'nested_archives').path).toBe('extra.zip');
    });

    it('rejects a backup archive', async () => {
        const app = await makeApp();
        addFile(app, 'backup.tar.gz', 'not really an archive');

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('nested_archives');
    });

    it('fails closed when an approved archive cannot be inspected', async () => {
        const app = await makeApp();
        addFile(app, 'WebPayload/vendor/pyodide/314.0.5/python_stdlib.zip', 'corrupt');

        const result = await inspect(app);

        expect(result.errors.map((e) => e.invariant)).toContain('nested_archives');
        expect(result.errors[0].path).toBe('WebPayload/vendor/pyodide/314.0.5/python_stdlib.zip');
    });

    it('allowlist is what rejects the fixture (non-vacuity)', async () => {
        const app = await makeApp();
        addFile(app, 'extra.zip', 'not really a zip');

        const relaxed = await inspect(app, {
            nested_archives: { ...basePolicy.nested_archives, forbidden_extensions_outside_allowlist: [] },
        });
        expect(relaxed.findings).toEqual([]);
    });
});

describe('bundle hygiene — filesystem safety and executable inventory', () => {
    it('rejects an unexpected executable bit on a data file', async () => {
        const app = await makeApp();
        const dataPath = addFile(app, 'WebPayload/app/app/main.js', 'console.log(1);');
        chmodSync(dataPath, 0o755);

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('executable_inventory');
    });

    it('rejects an escaping symlink', async () => {
        const app = await makeApp();
        symlinkSync('/etc/hosts', path.join(app, 'escape-link'));

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('filesystem_safety');
        expect(result.findings[0].reason).toMatch(/escapes the application bundle/);
    });

    it('rejects a world-writable resource', async () => {
        const app = await makeApp();
        const filePath = addFile(app, 'WebPayload/app/app/main.js', 'console.log(1);');
        chmodSync(filePath, 0o666);

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('filesystem_safety');
    });

    it('rejects unexpected native code', async () => {
        const app = await makeApp();
        addFile(app, 'EVIL.dylib', MACHO_MAGIC);

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('executable_inventory');
        expect(result.findings.find((f) => f.invariant === 'executable_inventory').path).toBe('EVIL.dylib');
    });

    it('rejects an unexpected framework directory', async () => {
        const app = await makeApp();
        addFile(app, 'Surprise.framework/Surprise', MACHO_MAGIC);

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('executable_inventory');
    });

    it('allows the intended app executable', async () => {
        const app = await makeApp();

        const result = await inspect(app);

        expect(result.findings.map((f) => f.path)).not.toContain('KeriWallet');
    });

    it('executable allowlist is what rejects the fixture (non-vacuity)', async () => {
        const app = await makeApp();
        addFile(app, 'helper-binary', MACHO_MAGIC);

        const relaxed = await inspect(app, {
            executable_inventory: {
                ...basePolicy.executable_inventory,
                allowed_executables: ['KeriWallet', 'helper-binary'],
            },
        });
        expect(relaxed.findings).toEqual([]);
    });
});

describe('bundle hygiene — secret material', () => {
    it('rejects private key material', async () => {
        const app = await makeApp();
        addFile(app, 'WebPayload/app/app/leaked.js', `const k = "${PRIVATE_KEY}";`);

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('secret_material');
    });

    it('rejects a credential file by name', async () => {
        const app = await makeApp();
        addFile(app, 'WebPayload/keys/device.p12', 'binary-ish');

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).toContain('secret_material');
    });

    it('does not classify the provisioning profile as secret material', async () => {
        const app = await makeApp();
        addFile(app, 'embedded.mobileprovision', 'platform signing metadata');

        const result = await inspect(app);

        expect(result.findings.map((f) => f.invariant)).not.toContain('secret_material');
    });
});

describe('bundle hygiene — size budgets', () => {
    it('rejects an oversized single file', async () => {
        const app = await makeApp();
        addFile(app, 'bigblob.bin', 'x'.repeat(4096));

        const result = await inspect(app, {
            size_budgets: { ...basePolicy.size_budgets, max_single_file_bytes: 1024 },
        });

        expect(result.findings.map((f) => f.invariant)).toContain('size_budgets');
    });

    it('rejects an accidental file-count blowup', async () => {
        const app = await makeApp();
        for (let i = 0; i < 12; i += 1) addFile(app, `vendor-page-${i}.html`);

        const result = await inspect(app, {
            size_budgets: { ...basePolicy.size_budgets, max_total_files: 5 },
        });

        expect(result.findings.map((f) => f.invariant)).toContain('size_budgets');
    });

    it('accepts a bundle within budget', async () => {
        const app = await makeApp();

        const result = await inspect(app);

        expect(result.findings.filter((f) => f.invariant === 'size_budgets')).toEqual([]);
    });
});

describe('bundle hygiene — entitlement contract', () => {
    const policy = basePolicy.entitlements;

    it('rejects get-task-allow for a distribution build', () => {
        const xml = '<plist><dict><key>get-task-allow</key><true/></dict></plist>';

        const result = evaluateEntitlementXml(xml, policy);

        expect(result.getTaskAllow).toBe(true);
        expect(result.findings.map((f) => f.path)).toContain('get-task-allow');
    });

    it('rejects an entitlement key outside the contract', () => {
        const xml = '<plist><dict><key>aps-environment</key><string>production</string></dict></plist>';

        const result = evaluateEntitlementXml(xml, policy);

        expect(result.findings.map((f) => f.path)).toContain('aps-environment');
    });

    it('accepts the approved standard keys', () => {
        const xml = '<plist><dict>'
            + '<key>application-identifier</key><string>TEAM.bundle</string>'
            + '<key>com.apple.developer.team-identifier</key><string>TEAM</string>'
            + '<key>get-task-allow</key><false/>'
            + '</dict></plist>';

        const result = evaluateEntitlementXml(xml, policy);

        expect(result.findings).toEqual([]);
    });
});
