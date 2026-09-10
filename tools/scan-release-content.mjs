#!/usr/bin/env node

/**
 * Release-content gate for App Store-incompatible runtime material.
 *
 * The iOS wrapper bundles a producer-owned runtime. Some of that runtime lives
 * inside nested ZIP archives (notably the Pyodide `python_stdlib.zip`), so a
 * scan that only walks regular files cannot certify the bytes we would submit.
 *
 * This module is the single scanner used by both:
 *
 *   - the staged payload gate      (`node tools/scan-release-content.mjs --dir WebPayload`)
 *   - the final archive assertion  (`tools/assert-release-archive.mjs`, which
 *     passes the payload root it located inside the .xcarchive)
 *
 * Design constraints:
 *   - Marker matching is byte-based, so binary members (.pyc and friends) are
 *     inspected exactly like text members.
 *   - Nested archives are opened with `execFileSync` and explicit argument
 *     arrays. Entry names are data, never shell syntax.
 *   - Inspection is bounded (depth, entry count, member bytes, total
 *     decompressed bytes) and fails closed: an archive that cannot be inspected
 *     is a gate failure, not a silent pass.
 *   - The scanner never mutates the artifact it inspects.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, 'release-sanitization-policy.json');
const POLICY_SECTION = 'release_content_gate';

const DEFAULT_LIMITS = {
    max_depth: 3,
    max_entries_per_archive: 20000,
    max_member_bytes: 64 * 1024 * 1024,
    max_total_decompressed_bytes: 512 * 1024 * 1024,
};

export function loadPolicy(policyPath = DEFAULT_POLICY) {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const section = policy[POLICY_SECTION];
    if (!section) {
        throw new Error(`policy is missing the "${POLICY_SECTION}" section: ${policyPath}`);
    }
    return section;
}

function markerPatterns(section) {
    return (section.forbidden_markers ?? []).map((marker) => ({
        pattern: marker.pattern,
        reason: marker.reason ?? '',
        bytes: Buffer.from(marker.pattern, 'utf8'),
    }));
}

function nestedArchiveConfig(section) {
    const nested = section.nested_archives ?? {};
    const limits = { ...DEFAULT_LIMITS, ...(nested.limits ?? {}) };
    return {
        extensions: new Set(nested.extensions ?? []),
        limits,
    };
}

/** Find every marker occurrence in a byte buffer. */
function findMarkers(bytes, markers) {
    const hits = [];
    for (const marker of markers) {
        if (marker.bytes.length > 0 && bytes.includes(marker.bytes)) {
            hits.push(marker);
        }
    }
    return hits;
}

function listZipMembers(zipPath, limits) {
    const out = execFileSync('unzip', ['-Z', '-1', zipPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const members = out.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
    if (members.length > limits.max_entries_per_archive) {
        throw new Error(
            `archive declares ${members.length} entries, above the inspection limit of ${limits.max_entries_per_archive}`,
        );
    }
    return members;
}

function readZipMember(zipPath, member, limits) {
    const bytes = execFileSync('unzip', ['-p', zipPath, member], {
        maxBuffer: limits.max_member_bytes,
    });
    return bytes;
}

/**
 * Scan a directory tree for forbidden release content, descending into nested
 * archives.
 *
 * @param {string} rootDir
 * @param {object} [options]
 * @param {object} [options.policy] - precast section (see loadPolicy)
 * @param {string} [options.policyPath]
 * @returns {Promise<{findings: object[], errors: object[], scannedFiles: number, inspectedArchives: number}>}
 */
export async function scanForbiddenContent(rootDir, options = {}) {
    const section = options.policy ?? loadPolicy(options.policyPath ?? DEFAULT_POLICY);
    const markers = markerPatterns(section);
    const extensionSet = new Set(section.scan_extensions ?? []);
    const excluded = new Set(section.exclude_files ?? []);
    const nested = nestedArchiveConfig(section);

    const findings = [];
    const errors = [];
    const state = { scannedFiles: 0, inspectedArchives: 0, decompressedBytes: 0 };
    const tempDirs = [];

    async function inspectArchive(archivePath, reportPrefix, depth) {
        state.inspectedArchives += 1;
        let members;
        try {
            members = listZipMembers(archivePath, nested.limits);
        } catch (e) {
            errors.push({
                file: reportPrefix,
                reason: `nested archive could not be inspected: ${e.message.split('\n')[0]}`,
            });
            return;
        }

        for (const member of members) {
            if (member.endsWith('/')) continue;
            const memberReport = `${reportPrefix}!${member}`;
            let bytes;
            try {
                bytes = readZipMember(archivePath, member, nested.limits);
            } catch (e) {
                errors.push({
                    file: memberReport,
                    reason: `archive member could not be read: ${e.message.split('\n')[0]}`,
                });
                continue;
            }

            state.decompressedBytes += bytes.length;
            if (state.decompressedBytes > nested.limits.max_total_decompressed_bytes) {
                errors.push({
                    file: reportPrefix,
                    reason: `decompressed content exceeded the inspection budget of ${nested.limits.max_total_decompressed_bytes} bytes`,
                });
                return;
            }

            for (const marker of findMarkers(bytes, markers)) {
                findings.push({ file: memberReport, marker: marker.pattern, reason: marker.reason });
            }

            const memberExtension = path.extname(member).toLowerCase();
            if (nested.extensions.has(memberExtension) && depth < nested.limits.max_depth) {
                const scratch = await mkdtemp(path.join(tmpdir(), 'fort-release-scan-'));
                tempDirs.push(scratch);
                const memberPath = path.join(scratch, 'member');
                await writeFile(memberPath, bytes);
                await inspectArchive(memberPath, memberReport, depth + 1);
            }
        }
    }

    async function walk(dir, prefix, depth) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (e) {
            errors.push({ file: prefix || '.', reason: `cannot read directory: ${e.message}` });
            return;
        }

        for (const entry of entries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absPath = path.join(dir, entry.name);

            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await walk(absPath, relPath, depth);
                continue;
            }
            if (!entry.isFile()) continue;

            const extension = path.extname(entry.name).toLowerCase();
            const isNestedArchive = nested.extensions.has(extension);
            const isScannedFile = extensionSet.has(extension);

            if (!isNestedArchive && !isScannedFile) continue;
            if (excluded.has(relPath) || excluded.has(entry.name)) continue;

            if (isNestedArchive) {
                await inspectArchive(absPath, relPath, 1);
                continue;
            }

            state.scannedFiles += 1;
            let bytes;
            try {
                bytes = await readFile(absPath);
            } catch (e) {
                errors.push({ file: relPath, reason: `cannot read file: ${e.message}` });
                continue;
            }
            for (const marker of findMarkers(bytes, markers)) {
                findings.push({ file: relPath, marker: marker.pattern, reason: marker.reason });
            }
        }
    }

    try {
        if (!existsSync(rootDir)) {
            throw new Error(`scan root does not exist: ${rootDir}`);
        }
        const rootStat = await stat(rootDir);
        if (!rootStat.isDirectory()) {
            throw new Error(`scan root is not a directory: ${rootDir}`);
        }
        await walk(rootDir, '', 0);
    } finally {
        for (const dir of tempDirs) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    return { findings, errors, scannedFiles: state.scannedFiles, inspectedArchives: state.inspectedArchives };
}

function parseArgs(argv) {
    const opts = { dir: null, policy: DEFAULT_POLICY, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dir') { opts.dir = path.resolve(argv[++i]); continue; }
        if (arg === '--policy') { opts.policy = path.resolve(argv[++i]); continue; }
        if (arg === '--json') { opts.json = true; continue; }
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        throw new Error(`unknown argument: ${arg}`);
    }
    return opts;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }

    if (opts.help || !opts.dir) {
        console.log('Usage: node tools/scan-release-content.mjs --dir <payload-dir> [--policy <file>] [--json]');
        console.log('Scans a staged payload (including nested ZIP archives) for release-gate forbidden content.');
        process.exit(opts.help ? 0 : 2);
    }

    let result;
    try {
        result = await scanForbiddenContent(opts.dir, { policyPath: opts.policy });
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`[release-content] scanned ${result.scannedFiles} files and ${result.inspectedArchives} nested archives`);
        for (const f of result.findings) {
            console.log(`[release-content] forbidden content: file=${f.file} marker=${f.marker}`);
        }
        for (const e of result.errors) {
            console.log(`[release-content] inspection error: file=${e.file} reason=${e.reason}`);
        }
    }

    const failed = result.findings.length > 0 || result.errors.length > 0;
    if (!opts.json) {
        console.log(
            `[release-content] result: ${failed ? 'FAIL' : 'PASS'} `
            + `(findings=${result.findings.length}, errors=${result.errors.length})`,
        );
    }
    process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main().catch((e) => {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    });
}
