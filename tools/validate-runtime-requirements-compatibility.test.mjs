import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const VALIDATOR = path.join(PROJECT_DIR, 'tools/validate-runtime-requirements-compatibility.mjs');
const CANONICAL_CONFIG = path.join(PROJECT_DIR, 'runtime-platform-config.json');
const PAYLOAD_DIR = path.join(PROJECT_DIR, 'WebPayload');

function runValidator(args = []) {
    try {
        execFileSync('node', [VALIDATOR, ...args], {
            cwd: PROJECT_DIR,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { passed: true };
    } catch (err) {
        return { passed: false, stderr: (err.stderr || '').toString() };
    }
}

async function withTempDir(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'rrc-test-'));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

// --- Positive ---

test('checked-in config is compatible with imported requirements', () => {
    const result = runValidator(['--payload', PAYLOAD_DIR, '--config', CANONICAL_CONFIG]);
    assert.ok(result.passed, `Expected compatibility: ${result.stderr}`);
});

test('compatibility evaluation is deterministic', () => {
    const r1 = runValidator(['--payload', PAYLOAD_DIR, '--config', CANONICAL_CONFIG]);
    const r2 = runValidator(['--payload', PAYLOAD_DIR, '--config', CANONICAL_CONFIG]);
    assert.equal(r1.passed, r2.passed);
});

// --- Negative: discovery ---

test('missing contracts descriptor is rejected', async () => {
    await withTempDir(async (dir) => {
        const manifest = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${path.join(PAYLOAD_DIR, 'manifest.json')}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        delete manifest.contracts;
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        const result = runValidator(['--payload', dir, '--config', CANONICAL_CONFIG]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /descriptor.*missing/);
    });
});

test('non-conventional descriptor path is rejected', async () => {
    await withTempDir(async (dir) => {
        const manifest = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${path.join(PAYLOAD_DIR, 'manifest.json')}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        manifest.contracts.runtime_requirements.path = 'other/path.json';
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        const result = runValidator(['--payload', dir, '--config', CANONICAL_CONFIG]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /conventional/);
    });
});

// --- Negative: byte integrity ---

test('byte-count mismatch is rejected', async () => {
    await withTempDir(async (dir) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(dir, 'contracts'), { recursive: true });
        const manifest = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${path.join(PAYLOAD_DIR, 'manifest.json')}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        const entry = manifest.files.find((f) => f.path === 'contracts/runtime-requirements.json');
        entry.bytes = 99999;
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync('${path.join(PAYLOAD_DIR, 'contracts/runtime-requirements.json')}','utf8'))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        const result = runValidator(['--payload', dir, '--config', CANONICAL_CONFIG]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /byte.count/i);
    });
});

// --- Negative: semantic ---

test('unsupported requirements schema is rejected', async () => {
    await withTempDir(async (dir) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(dir, 'contracts'), { recursive: true });
        const manifest = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${path.join(PAYLOAD_DIR, 'manifest.json')}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        const rr = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync('${path.join(PAYLOAD_DIR, 'contracts/runtime-requirements.json')}','utf8'))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        rr.schema = 'com.other.v99';
        const rrText = JSON.stringify(rr);
        const entry = manifest.files.find((f) => f.path === 'contracts/runtime-requirements.json');
        entry.bytes = Buffer.byteLength(rrText, 'utf8');
        entry.sha256 = execFileSync('node', ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(rrText)}).digest('hex'))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), rrText);
        const result = runValidator(['--payload', dir, '--config', CANONICAL_CONFIG]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /Unsupported requirements schema/);
    });
});

test('unknown required capability is rejected', async () => {
    await withTempDir(async (dir) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(dir, 'contracts'), { recursive: true });
        const manifest = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${path.join(PAYLOAD_DIR, 'manifest.json')}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        const rr = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync('${path.join(PAYLOAD_DIR, 'contracts/runtime-requirements.json')}','utf8'))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        rr.capabilities.unknown_cap = { required: true, description: 'Unknown' };
        const rrText = JSON.stringify(rr);
        const entry = manifest.files.find((f) => f.path === 'contracts/runtime-requirements.json');
        entry.bytes = Buffer.byteLength(rrText, 'utf8');
        entry.sha256 = execFileSync('node', ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(rrText)}).digest('hex'))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), rrText);
        const result = runValidator(['--payload', dir, '--config', CANONICAL_CONFIG]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /Unknown required capability/);
    });
});

test('platform mechanism conflict is rejected', async () => {
    const badConfig = path.join(tmpdir(), 'bad-config.json');
    try {
        const cfg = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require('${CANONICAL_CONFIG}'),null,2))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        cfg.network.policy = 'allow-some';
        await writeFile(badConfig, JSON.stringify(cfg));
        const result = runValidator(['--payload', PAYLOAD_DIR, '--config', badConfig]);
        assert.ok(!result.passed);
        assert.match(result.stderr, /compatibility failure/);
    } finally {
        await rm(badConfig, { force: true });
    }
});
