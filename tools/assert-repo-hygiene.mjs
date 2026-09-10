#!/usr/bin/env node

/**
 * Tracked-file repository hygiene validator.
 *
 * .gitignore is developer convenience, not a security boundary: `git add -f`
 * bypasses it, and ignored files that were already tracked stay tracked. This
 * validator therefore inspects `git ls-files` — the actual tracked tree — so
 * build output, derived data, local credentials, and private keys cannot reach
 * Git history or a release candidate unnoticed.
 *
 * Two boundaries:
 *   A. forbidden tracked paths and names (generated / local-only material)
 *   B. tracked secret material, high-confidence markers only
 *
 * Policy lives in `repo_hygiene` in tools/release-sanitization-policy.json, with
 * path-scoped exceptions that each carry a written reason. Nothing is ignored
 * globally: a new exception is an explicit policy change.
 *
 * Usage:
 *   node tools/assert-repo-hygiene.mjs [--root <dir>] [--policy <path>]
 *     [--json <path>]
 *
 * Exit codes:
 *   0 — tracked tree is clean
 *   1 — finding (forbidden tracked content or tracked secret material)
 *   2 — tool error (not a Git work tree, unreadable policy)
 */

import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY = path.join(__dirname, 'release-sanitization-policy.json');

const POLICY_SECTION = 'repo_hygiene';

function parseArgs(argv) {
    const opts = { root: DEFAULT_ROOT, policy: DEFAULT_POLICY, json: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--root') { opts.root = path.resolve(argv[++i]); continue; }
        if (arg === '--policy') { opts.policy = path.resolve(argv[++i]); continue; }
        if (arg === '--json') { opts.json = path.resolve(argv[++i]); continue; }
        throw new Error(`unknown argument: ${arg}`);
    }
    return opts;
}

function toolError(message) {
    process.stderr.write(`[repo-hygiene] TOOL ERROR: ${message}\n`);
    process.exit(2);
}

/**
 * Glob matcher for repository-relative POSIX paths.
 *
 * A leading double-star segment matches zero or more directories, so a log
 * pattern also catches a root-level log file. A trailing double-star segment
 * matches everything beneath a path, a single star stays inside one path
 * segment, and `?` matches a single non-separator character.
 */
function globToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') {
                    out += '(?:.*/)?';
                    i += 2;
                } else {
                    out += '.*';
                    i += 1;
                }
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '[^/]';
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

function matchesAny(value, patterns) {
    return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

async function listTrackedFiles(root) {
    let insideWorkTree;
    try {
        const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
            encoding: 'utf8',
        });
        insideWorkTree = stdout.trim();
    } catch (error) {
        throw new Error(`${root} is not a Git work tree: ${error.message.split('\n')[0]}`);
    }
    if (insideWorkTree !== 'true') {
        throw new Error(`${root} is not a Git work tree`);
    }

    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split('\0').filter((entry) => entry.length > 0).sort();
}

/** Tracked paths and names that must never be committed. */
function inspectPaths(trackedPaths, policy) {
    const findings = [];
    const forbiddenPaths = policy.forbidden_tracked_paths ?? [];
    const forbiddenNames = policy.forbidden_tracked_names ?? [];
    const nameExceptions = (policy.name_exceptions ?? []).map((entry) => entry.name);

    for (const trackedPath of trackedPaths) {
        if (matchesAny(trackedPath, forbiddenPaths)) {
            findings.push({
                rule: 'forbidden_tracked_path',
                path: trackedPath,
                reason: 'generated or local-only content is tracked in Git; .gitignore does not apply to files added with git add -f',
            });
            continue;
        }

        const name = path.posix.basename(trackedPath);
        if (nameExceptions.includes(name)) continue;
        if (matchesAny(name, forbiddenNames)) {
            findings.push({
                rule: 'forbidden_tracked_name',
                path: trackedPath,
                reason: 'secret-sensitive file name is tracked in Git',
            });
        }
    }

    return findings;
}

/** High-confidence secret markers inside tracked text files. */
async function inspectSecretContent(root, trackedPaths, policy) {
    const spec = policy.secret_content ?? {};
    const markers = spec.markers ?? [];
    const skipExtensions = new Set(spec.skip_extensions ?? []);
    const exceptions = (spec.exceptions ?? []).map((entry) => entry.pattern);
    const maxScanBytes = spec.max_scan_bytes ?? 1048576;
    const findings = [];

    for (const trackedPath of trackedPaths) {
        if (markers.length === 0) break;
        if (matchesAny(trackedPath, exceptions)) continue;
        if (skipExtensions.has(path.posix.extname(trackedPath))) continue;

        const absolute = path.join(root, trackedPath);
        let info;
        try {
            info = await stat(absolute);
        } catch {
            continue;
        }
        if (!info.isFile() || info.size > maxScanBytes) continue;

        const bytes = await readFile(absolute);
        if (bytes.subarray(0, 8192).includes(0)) continue; // binary payload

        const text = bytes.toString('utf8');
        for (const marker of markers) {
            if (text.includes(marker)) {
                findings.push({
                    rule: 'tracked_secret_content',
                    path: trackedPath,
                    reason: `tracked file contains private key material (marker: ${marker})`,
                });
            }
        }
    }

    return findings;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    let policyDocument;
    try {
        policyDocument = JSON.parse(await readFile(opts.policy, 'utf8'));
    } catch (error) {
        toolError(`cannot read policy ${opts.policy}: ${error.message.split('\n')[0]}`);
    }

    const policy = policyDocument[POLICY_SECTION];
    if (!policy || typeof policy !== 'object') {
        toolError(`policy ${opts.policy} has no ${POLICY_SECTION} section`);
    }

    let trackedPaths;
    try {
        trackedPaths = await listTrackedFiles(opts.root);
    } catch (error) {
        toolError(error.message);
    }

    const findings = [
        ...inspectPaths(trackedPaths, policy),
        ...(await inspectSecretContent(opts.root, trackedPaths, policy)),
    ];

    console.log(`[repo-hygiene] root: ${opts.root}`);
    console.log(`[repo-hygiene] tracked files checked: ${trackedPaths.length}`);

    for (const finding of findings) {
        console.log('[repo-hygiene] finding');
        console.log(`  rule: ${finding.rule}`);
        console.log(`  path: ${finding.path}`);
        console.log(`  reason: ${finding.reason}`);
    }

    const passed = findings.length === 0;
    console.log(`[repo-hygiene] ${
        passed
            ? 'ok: tracked tree satisfies the repository hygiene policy'
            : `findings: ${findings.length}`
    }`);
    console.log(`[repo-hygiene] result: ${passed ? 'PASS' : 'FAIL'}`);

    if (opts.json) {
        await writeFile(opts.json, `${JSON.stringify({
            schema: 'fort.ios-repo-hygiene-report.v1',
            root: opts.root,
            policy: opts.policy,
            trackedFiles: trackedPaths.length,
            findings,
            result: passed ? 'PASS' : 'FAIL',
        }, null, 2)}\n`);
    }

    if (!passed) process.exitCode = 1;
}

main().catch((error) => {
    toolError(error instanceof Error ? error.message : String(error));
});
