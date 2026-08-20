import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const downloadScript = path.join(repoRoot, 'scripts', 'download-pyodide.sh');

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Extract the single Pyodide version declared by the active browser-harness
 * downloader. The production iOS payload does not own a version here — it
 * derives the version from the FortWeb producer manifest (see
 * tools/assert-pyodide-runtime.mjs) — so this script is the only place the
 * wrapper's browser harness may declare a version.
 */
async function readDownloaderVersion() {
    const content = await readFile(downloadScript, 'utf8');
    const match = content.match(/^PYODIDE_VERSION="([^"]+)"$/m);
    if (!match) {
        throw new Error('PYODIDE_VERSION is not declared in scripts/download-pyodide.sh');
    }
    return match[1];
}

/**
 * Derive the producer-owned Pyodide version from the FortWeb vendor tree.
 * Returns null when FortWeb is not checked out alongside this repo, in which
 * case the version-alignment assertion is skipped rather than failed.
 */
async function readProducerPyodideVersion() {
    for (const base of [
        path.join(repoRoot, '..', 'fortweb', 'vendor', 'pyodide'),
        path.join(repoRoot, 'WebPayload', 'vendor', 'pyodide'),
    ]) {
        try {
            const entries = await readdir(base, { withFileTypes: true });
            const versions = entries
                .filter((e) => e.isDirectory() && VERSION_RE.test(e.name))
                .map((e) => e.name);
            if (versions.length === 1) {
                return versions[0];
            }
            if (versions.length > 1) {
                throw new Error(`Multiple Pyodide versions present under ${base}: ${versions.join(', ')}`);
            }
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
    return null;
}

describe('Pyodide version authority', () => {
    it('declares a single valid version in the active browser-harness downloader', async () => {
        const version = await readDownloaderVersion();
        expect(version).toMatch(VERSION_RE);
    });

    it('download-pyodide.sh matches the FortWeb producer Pyodide version', async () => {
        const downloaderVersion = await readDownloaderVersion();
        const producerVersion = await readProducerPyodideVersion();
        if (producerVersion !== null) {
            expect(downloaderVersion).toBe(producerVersion);
        }
    });
});
