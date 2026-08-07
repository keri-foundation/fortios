import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const VALIDATOR = path.join(PROJECT_DIR, 'tools/validate-runtime-platform-config.mjs');
const CANONICAL_CONFIG = path.join(PROJECT_DIR, 'runtime-platform-config.json');

function runValidator(configPath) {
    try {
        execFileSync('node', [VALIDATOR, '--config', configPath], {
            cwd: PROJECT_DIR,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { passed: true };
    } catch (err) {
        return { passed: false, stderr: (err.stderr || '').toString() };
    }
}

async function withTempConfig(mutator) {
    const dir = await mkdtemp(path.join(tmpdir(), 'rpc-test-'));
    const configPath = path.join(dir, 'config.json');
    try {
        const canonical = JSON.parse(
            execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${CANONICAL_CONFIG}'),null,2))`], {
                cwd: PROJECT_DIR,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
        mutator(canonical);
        await writeFile(configPath, JSON.stringify(canonical, null, 2));
        return configPath;
    } finally {
        // Cleanup deferred — caller's responsibility
    }
}

// --- Positive ---

test('checked-in configuration passes structural validation', () => {
    const result = runValidator(CANONICAL_CONFIG);
    assert.ok(result.passed, `Expected canonical config to pass: ${result.stderr}`);
});

test('configuration parsing is deterministic', () => {
    const r1 = runValidator(CANONICAL_CONFIG);
    const r2 = runValidator(CANONICAL_CONFIG);
    assert.equal(r1.passed, r2.passed);
});

// --- Negative: top-level ---

test('missing schema field is rejected', async () => {
    const cp = await withTempConfig((c) => { delete c.schema; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /schema/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('unsupported schema is rejected', async () => {
    const cp = await withTempConfig((c) => { c.schema = 'com.other.v99'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /schema/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('unsupported version is rejected', async () => {
    const cp = await withTempConfig((c) => { c.version = 99; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /version/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('wrong platform is rejected', async () => {
    const cp = await withTempConfig((c) => { c.platform = 'android-webview'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /platform/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('unknown top-level field is rejected', async () => {
    const cp = await withTempConfig((c) => { c.extra_field = 'nope'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /unknown field/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('missing required top-level field is rejected', async () => {
    const cp = await withTempConfig((c) => { delete c.origin; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

// --- Negative: sub-objects ---

test('unknown field in origin is rejected', async () => {
    const cp = await withTempConfig((c) => { c.origin.extra = 'nope'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /unknown field/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('invalid enum in network policy is rejected', async () => {
    const cp = await withTempConfig((c) => { c.network.policy = 'allow-some'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /network.policy/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('non-boolean workers.available is rejected', async () => {
    const cp = await withTempConfig((c) => { c.workers.available = 'yes'; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /boolean/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('duplicate in allowed_schemes is rejected', async () => {
    const cp = await withTempConfig((c) => { c.network.allowed_schemes = ['app', 'app']; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /duplicate/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('malformed JSON is rejected', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rpc-test-'));
    const cp = path.join(dir, 'config.json');
    try {
        await writeFile(cp, 'not json {{{');
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /not valid JSON/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('wrong type for string field is rejected', async () => {
    const cp = await withTempConfig((c) => { c.origin.scheme = 42; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /must be a non-empty string/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('empty string field is rejected', async () => {
    const cp = await withTempConfig((c) => { c.origin.scheme = ''; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /non-empty/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('unsupported requirements schema in compatibility is rejected', async () => {
    const cp = await withTempConfig((c) => { c.requirements_compatibility.supported_schemas = ['com.fake.v1']; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /unsupported schema/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});

test('empty supported_schemas is rejected', async () => {
    const cp = await withTempConfig((c) => { c.requirements_compatibility.supported_schemas = []; });
    try {
        const result = runValidator(cp);
        assert.ok(!result.passed);
        assert.match(result.stderr, /must not be empty/);
    } finally {
        await rm(path.dirname(cp), { recursive: true, force: true });
    }
});
