#!/usr/bin/env node

/**
 * Mobile payload scanner for Fort-ios.
 *
 * Validates the staged WebPayload against wrapper-level invariants:
 * banned proof-shell markers, wrapper redirect, entry document
 * existence, and local script references.
 *
 * Producer manifest and integrity are validated by
 * assert-payload-integrity.mjs — this tool does not duplicate that work.
 *
 * Read-only. Exits 1 on wrapper-level violations.
 *
 * Usage:
 *   node tools/validate-mobile-payload.mjs --payload-dir <path> [--target ios-webpayload]
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const TEXT_FILE_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt']);

const ENTRY_DOCUMENT = 'app/index.html';
const ENTRY_SCRIPT = 'app/app/main.js';
const WRAPPER_REDIRECT = './app/index.html';

const BANNED_MARKERS = [
    { marker: 'Profile ID',            reason: 'legacy proof-shell field labels must not ship' },
    { marker: 'profile-id',            reason: 'legacy proof-shell field ids must not ship' },
    { marker: 'Display name',          reason: 'legacy proof-shell placeholder copy must not ship' },
    { marker: 'Optional note',         reason: 'legacy proof-shell placeholder copy must not ship' },
    { marker: 'No record loaded',      reason: 'legacy proof-shell record state must not ship' },
    { marker: 'Seed Test Data',        reason: 'legacy local validation controls must not ship' },
    { marker: 'List Identifiers',      reason: 'legacy local validation controls must not ship' },
    { marker: 'Pyodide boot failed',   reason: 'legacy failure copy must not ship' },
    { marker: 'Importing a module script failed', reason: 'legacy module-loader failure copy must not ship' },
    { marker: 'fort-ios-local',        reason: 'wrapper must not identify payload as local Fort-ios producer' },
    { marker: 'proof-shell',           reason: 'wrapper must not identify payload as proof-shell profile' },
];

// --- Helpers ---

function parseArgs(argv) {
    const opts = { payloadDir: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--payload-dir') { opts.payloadDir = path.resolve(argv[i + 1]); i += 1; continue; }
        if (argv[i] === '--target') { i += 1; continue; } // accepted, ignored (legacy)
        throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (!opts.payloadDir) throw new Error('--payload-dir is required');
    return opts;
}

async function listFilesRec(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { files.push(...(await listFilesRec(p))); continue; }
        if (e.isFile()) files.push(p);
    }
    return files;
}

function v(file, reason, expected) {
    return { file, reason, expected };
}

// --- Wrapper layout ---

async function validateWrapperLayout(payloadDir) {
    const violations = [];
    const expected = 'Fort-ios wrapper must serve the imported FortWeb runtime payload.';

    // Redirect index.html
    let indexHtml;
    try { indexHtml = await readFile(path.join(payloadDir, 'index.html'), 'utf8'); } catch {
        violations.push(v('index.html', 'missing wrapper root document', expected));
        return violations;
    }
    if (!indexHtml.includes(WRAPPER_REDIRECT)) {
        violations.push(v('index.html', `wrapper root must redirect to ${WRAPPER_REDIRECT}`, expected));
    }

    // Entry document
    try { await readFile(path.join(payloadDir, ENTRY_DOCUMENT)); } catch {
        violations.push(v(ENTRY_DOCUMENT, 'missing FortWeb entry document', expected));
    }

    // Entry script
    try { await readFile(path.join(payloadDir, ENTRY_SCRIPT)); } catch {
        violations.push(v(ENTRY_SCRIPT, 'missing FortWeb entry script', expected));
    }

    // Local script references in entry HTML
    violations.push(...(await checkEntryScripts(payloadDir)));

    return violations;
}

async function checkEntryScripts(payloadDir) {
    const violations = [];
    const entryPath = path.join(payloadDir, ENTRY_DOCUMENT);
    const entryDir = path.dirname(entryPath);

    let html;
    try { html = await readFile(entryPath, 'utf8'); } catch { return violations; }

    const re = /<script\s[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const src = m[1];
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) continue;
        const resolved = path.resolve(entryDir, src.split('?')[0].split('#')[0]);
        if (!resolved.startsWith(path.resolve(payloadDir))) {
            violations.push(v(ENTRY_DOCUMENT, `script src escapes payload root: ${src}`, 'all scripts must be payload-local'));
            continue;
        }
        try { await readFile(resolved); } catch {
            violations.push(v(ENTRY_DOCUMENT, `script src references missing file: ${src}`, 'all script references must resolve'));
        }
    }
    return violations;
}

// --- Banned markers ---

async function scanForBannedMarkers(payloadDir) {
    const matches = [];
    const files = await listFilesRec(payloadDir);
    const expected = 'Banned proof-shell markers must not appear in any staged file.';

    for (const absPath of files) {
        if (!TEXT_FILE_EXTENSIONS.has(path.extname(absPath))) continue;
        const relPath = path.relative(payloadDir, absPath).replaceAll('\\', '/');
        const content = await readFile(absPath, 'utf8');
        for (const { marker, reason } of BANNED_MARKERS) {
            if (content.includes(marker)) {
                matches.push({ file: relPath, string: marker, reason, expected });
            }
        }
    }
    return matches;
}

// --- Main ---

async function main() {
    const { payloadDir } = parseArgs(process.argv.slice(2));

    console.log(`[payload-check] payload directory: ${payloadDir}`);
    console.log(`[payload-check] layout: ZIP-import (producer manifest.json validated by assert-payload-integrity.mjs)`);

    const violations = [
        ...(await validateWrapperLayout(payloadDir)),
        ...(await scanForBannedMarkers(payloadDir)),
    ];

    if (violations.length === 0) {
        console.log('[payload-check] result: PASS');
        return;
    }

    for (const v of violations) {
        console.log('[payload-check] violation');
        console.log(`  file: ${v.file}`);
        if (v.string) console.log(`  string: ${JSON.stringify(v.string)}`);
        console.log(`  reason: ${v.reason}`);
        console.log(`  expected: ${v.expected}`);
    }

    console.log('[payload-check] result: FAIL');
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[payload-check] result: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
