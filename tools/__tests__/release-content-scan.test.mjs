import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPolicy, scanForbiddenContent } from '../scan-release-content.mjs';

/**
 * Regression coverage for the release-content gate.
 *
 * The gate exists because the offending material (CPython's `itms-services`
 * URL-scheme handling) lives inside a nested ZIP member, which a flat file walk
 * cannot see.
 */

const TOKEN = 'itms-services';
const CLEAN_TEXT = 'print("interpreter is fine")\n';

const tempDirs = [];

async function makeTempDir() {
    const dir = await mkdtemp(path.join(tmpdir(), 'fort-release-scan-'));
    tempDirs.push(dir);
    return dir;
}

function writeFileAt(root, relPath, contents) {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    return full;
}

/**
 * Build a ZIP from a source directory using an argument array (never a shell
 * string). Contents are added relative to the source directory, matching the
 * layout of the real python_stdlib.zip.
 */
function zipDir(sourceDir, zipPath) {
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir, encoding: 'utf8' });
    return zipPath;
}

const shippedPolicy = loadPolicy();

describe('release content gate — shipped policy', () => {
    it('declares the itms-services marker and inspects nested archives', () => {
        const patterns = shippedPolicy.forbidden_markers.map((marker) => marker.pattern);
        expect(patterns).toContain(TOKEN);
        expect(shippedPolicy.nested_archives.extensions).toContain('.zip');
    });
});

describe('release content gate — scanning behavior', () => {
    it('A. passes a clean payload', async () => {
        const root = await makeTempDir();
        writeFileAt(root, 'app/runtime/clean.py', CLEAN_TEXT);
        writeFileAt(root, 'app/index.html', '<html></html>');

        const result = await scanForbiddenContent(root);

        expect(result.findings).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.scannedFiles).toBeGreaterThan(0);
    });

    it('B. fails on the token in a regular file', async () => {
        const root = await makeTempDir();
        writeFileAt(root, 'app/runtime/parse.py', `URL_SCHEMES = {"${TOKEN}": "install"}\n`);

        const result = await scanForbiddenContent(root);

        expect(result.findings.map((f) => f.file)).toContain('app/runtime/parse.py');
    });

    it('C. passes a clean nested archive', async () => {
        const root = await makeTempDir();
        const staging = await makeTempDir();
        writeFileAt(staging, 'stdlib/urllib/parse.py', CLEAN_TEXT);
        zipDir(path.join(staging, 'stdlib'), path.join(root, 'python_stdlib.zip'));

        const result = await scanForbiddenContent(root);

        expect(result.findings).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.inspectedArchives).toBe(1);
    });

    it('D. fails on the token inside a nested archive text member', async () => {
        const root = await makeTempDir();
        const staging = await makeTempDir();
        writeFileAt(staging, 'stdlib/urllib/parse.py', `uses = "${TOKEN}"\n`);
        zipDir(path.join(staging, 'stdlib'), path.join(root, 'python_stdlib.zip'));

        const result = await scanForbiddenContent(root);

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].file).toBe('python_stdlib.zip!urllib/parse.py');
        expect(result.findings[0].marker).toBe(TOKEN);
    });

    it('E. fails on the token inside a nested archive binary member', async () => {
        const root = await makeTempDir();
        const staging = await makeTempDir();
        // A binary member: bytes are not valid UTF-8 text, so a decode-then-search
        // scanner would miss it.
        const binary = Buffer.concat([
            Buffer.from([0x00, 0xff, 0xfe, 0x00]),
            Buffer.from(TOKEN, 'utf8'),
            Buffer.from([0x00, 0x80]),
        ]);
        const memberPath = writeFileAt(staging, 'stdlib/urllib/__pycache__/parse.cpython-314.pyc', binary);
        expect(existsSync(memberPath)).toBe(true);
        zipDir(path.join(staging, 'stdlib'), path.join(root, 'python_stdlib.zip'));

        const result = await scanForbiddenContent(root);

        expect(result.findings.map((f) => f.file)).toContain(
            'python_stdlib.zip!urllib/__pycache__/parse.cpython-314.pyc',
        );
    });

    it('F. fails closed when a nested archive cannot be inspected', async () => {
        const root = await makeTempDir();
        writeFileAt(root, 'corrupt.zip', 'this is not a zip archive');

        const result = await scanForbiddenContent(root);

        expect(result.findings).toEqual([]);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].file).toBe('corrupt.zip');
    });

    it('G. treats adversarial archive and member names literally', async () => {
        const root = await makeTempDir();
        const staging = await makeTempDir();
        const sentinel = 'fort-release-scan-injection-sentinel';
        const memberName = `urllib; touch ${sentinel}; $(id) \`id\`.py`;
        writeFileAt(staging, `stdlib/${memberName}`, `uses = "${TOKEN}"\n`);

        const adversarialZipName = `stdlib (nested) 'quoted' $dollar.zip`;
        const zipPath = path.join(staging, adversarialZipName);
        zipDir(path.join(staging, 'stdlib'), zipPath);
        renameSync(zipPath, path.join(root, adversarialZipName));

        const result = await scanForbiddenContent(root);

        // The member is found, so the name was treated as literal data.
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].file).toBe(`${adversarialZipName}!${memberName}`);

        // No adjacent command may have executed.
        expect(existsSync(path.join(root, sentinel))).toBe(false);
        expect(existsSync(path.join(staging, sentinel))).toBe(false);
        expect(existsSync(path.join(process.cwd(), sentinel))).toBe(false);
    });

    it('nested traversal is what catches the token (non-vacuity control)', async () => {
        const root = await makeTempDir();
        const staging = await makeTempDir();
        writeFileAt(staging, 'stdlib/urllib/parse.py', `uses = "${TOKEN}"\n`);
        zipDir(path.join(staging, 'stdlib'), path.join(root, 'python_stdlib.zip'));

        const withNested = await scanForbiddenContent(root);
        expect(withNested.findings).toHaveLength(1);

        // Same fixture, nested traversal disabled: the finding disappears. This
        // proves the nested-archive inspection is the behavior under test rather
        // than an incidental match elsewhere.
        const withoutNested = await scanForbiddenContent(root, {
            policy: { ...shippedPolicy, nested_archives: { ...shippedPolicy.nested_archives, extensions: [] } },
        });
        expect(withoutNested.findings).toEqual([]);
    });
});
