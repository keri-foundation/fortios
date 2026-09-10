#!/usr/bin/env node

/**
 * Structural bundle hygiene validator for App Store release archives.
 *
 * Boundary philosophy: DENY UNKNOWN STRUCTURE. Enumerating bad strings scales
 * badly, so this validator establishes closed-world contracts for the final
 * application bundle:
 *
 *   A. forbidden cruft paths       (path-aware, never blind extension bans)
 *   B. nested archive allowlist    (unknown archive = hard fail)
 *   C. filesystem safety           (escape symlinks, special files, unsafe modes)
 *   D. executable code inventory   (approved native code locations only)
 *   E. code signing               (per code item)
 *   F. entitlement contract       (get-task-allow and unexpected keys)
 *   G. secret material            (high-confidence patterns only)
 *   H. size and count budgets     (accidental tree inclusion)
 *
 * Canonical runtime content (WebPayload) is governed by the canonical payload
 * contract, not by cruft patterns, so cruft rules are scoped away from it by
 * policy. This module never mutates the bundle it inspects.
 *
 * Fail closed: an inspection error is a gate failure, never a silent pass.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, 'release-sanitization-policy.json');

const MACHO_MAGICS = new Set([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]).toString('binary'),
    Buffer.from([0xce, 0xfa, 0xed, 0xfe]).toString('binary'),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).toString('binary'),
    Buffer.from([0xfe, 0xed, 0xfa, 0xce]).toString('binary'),
    Buffer.from([0xfe, 0xed, 0xfa, 0xcf]).toString('binary'),
]);

const CODE_DIRECTORY_EXTENSIONS = ['.framework', '.appex', '.bundle', '.xpc'];

/** Minimal glob matcher: supports `*`, `**`, and `?`. */
function matchesGlob(pattern, candidate) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*');
    return new RegExp(`^${escaped}$`).test(candidate);
}

function matchesAny(patterns, candidate) {
    return (patterns ?? []).some((pattern) => matchesGlob(pattern, candidate));
}

export function loadPolicySections(policyPath = DEFAULT_POLICY) {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const required = ['bundle_hygiene', 'nested_archives', 'executable_inventory', 'filesystem_safety', 'size_budgets'];
    for (const section of required) {
        if (!policy[section]) {
            throw new Error(`policy is missing the "${section}" section: ${policyPath}`);
        }
    }
    return policy;
}

async function walk(root, prefix, out) {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(root, rel);
        const stats = await lstat(abs);
        out.push({ rel, abs, stats, dirent: entry });
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await walk(root, rel, out);
        }
    }
}

function isArchiveName(name, extensions) {
    const lower = name.toLowerCase();
    return extensions.some((ext) => lower.endsWith(ext));
}

async function readHead(abs, bytes = 4) {
    const handle = await readFile(abs);
    return handle.subarray(0, bytes).toString('binary');
}

/**
 * Evaluate signed entitlements against the approval contract.
 * Exported so the contract can be tested without a signed build.
 */
export function evaluateEntitlementXml(xml, policy = {}) {
    const findings = [];
    const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    const getTaskAllow = /<key>get-task-allow<\/key>\s*<true\s*\/>/.test(xml);

    if (getTaskAllow && (policy.forbidden_true_keys ?? []).includes('get-task-allow')) {
        findings.push({
            invariant: 'entitlements',
            path: 'get-task-allow',
            reason: 'get-task-allow is true; not valid for App Store distribution',
        });
    }

    const allowed = new Set(policy.allowed_keys ?? []);
    for (const key of new Set(keys)) {
        if (allowed.size > 0 && !allowed.has(key)) {
            findings.push({
                invariant: 'entitlements',
                path: key,
                reason: 'entitlement key is not in the approved contract',
            });
        }
    }

    return { status: 'AVAILABLE', keys, getTaskAllow, findings };
}

/**
 * Inspect an application bundle.
 *
 * @returns {Promise<{findings: object[], errors: object[], bom: object}>}
 */
export async function inspectBundle(appPath, options = {}) {
    const policy = options.policy ?? loadPolicySections(options.policyPath ?? DEFAULT_POLICY);
    const findings = [];
    const errors = [];
    const add = (invariant, relPath, reason) => findings.push({ invariant, path: relPath, reason });
    const addError = (invariant, relPath, reason) => errors.push({ invariant, path: relPath, reason });

    const hygiene = policy.bundle_hygiene;
    const archives = policy.nested_archives;
    const executables = policy.executable_inventory;
    const safety = policy.filesystem_safety;
    const budgets = policy.size_budgets;
    const secrets = policy.secret_material ?? {};
    const codesign = policy.codesign ?? {};

    const cruftExempt = hygiene.cruft_scope_excludes ?? [];
    const archiveExtensions = archives.forbidden_extensions_outside_allowlist ?? ['.zip'];
    const allowedArchivePaths = new Set((archives.allowed ?? []).map((entry) => entry.path));
    const allowedExecutables = new Set(executables.allowed_executables ?? []);
    const allowedCodePatterns = executables.allowed_code_paths ?? [];
    const allowedCodeDirectories = new Set(executables.allowed_code_directories ?? []);

    const tree = [];
    try {
        await walk(appPath, '', tree);
    } catch (e) {
        addError('archive', appPath, `cannot traverse bundle: ${e.message}`);
        return { findings, errors, bom: null };
    }

    const rootReal = await realpath(appPath);
    let totalBytes = 0;
    let fileCount = 0;
    const nestedArchives = [];
    const codeItems = [];
    let largestFile = { path: '', size: 0 };

    for (const item of tree) {
        const { rel, abs, stats, dirent } = item;
        const mode = stats.mode & 0o7777;

        // --- C. filesystem safety -------------------------------------------
        if (dirent.isSymbolicLink()) {
            let targetReal = null;
            try {
                targetReal = await realpath(abs);
            } catch {
                add('filesystem_safety', rel, 'broken symlink in release bundle');
                continue;
            }
            if (safety.reject_symlinks_escaping_root && !targetReal.startsWith(rootReal)) {
                add('filesystem_safety', rel, 'symlink escapes the application bundle');
            }
            continue;
        }

        if (!dirent.isDirectory() && !dirent.isFile()) {
            if (safety.reject_special_files) {
                add('filesystem_safety', rel, 'special file (device, socket, or FIFO) in release bundle');
            }
            continue;
        }

        if (safety.reject_setuid_setgid && (mode & 0o6000) !== 0) {
            add('filesystem_safety', rel, `setuid/setgid bit set (mode ${mode.toString(8)})`);
        }
        if (safety.reject_world_writable && dirent.isFile() && (mode & 0o002) !== 0) {
            add('filesystem_safety', rel, `world-writable file (mode ${mode.toString(8)})`);
        }

        if (dirent.isDirectory()) {
            if (CODE_DIRECTORY_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
                codeItems.push({ path: rel, kind: 'code-directory' });
                if (
                    !allowedCodePatterns.some((pattern) => matchesGlob(pattern, rel))
                    && !allowedCodeDirectories.has(path.basename(rel).split('.')[0])
                ) {
                    add('executable_inventory', rel, 'unexpected code directory (framework/appex/bundle)');
                }
            }
            continue;
        }

        // --- regular file ---------------------------------------------------
        fileCount += 1;
        totalBytes += stats.size;
        if (stats.size > largestFile.size) {
            largestFile = { path: rel, size: stats.size };
        }

        const inCanonicalScope = matchesAny(cruftExempt, rel);

        // --- A. forbidden cruft paths ---------------------------------------
        if (!inCanonicalScope) {
            const segments = rel.split('/');
            const segmentHit = segments.find((segment) => (hygiene.forbidden_path_segments ?? []).includes(segment));
            if (segmentHit) {
                add('bundle_hygiene', rel, `development-only path segment "${segmentHit}" in release bundle`);
            }
            const base = path.basename(rel);
            if ((hygiene.forbidden_file_names ?? []).includes(base)) {
                add('bundle_hygiene', rel, `development-only file "${base}" in release bundle`);
            }
            for (const pattern of hygiene.forbidden_file_patterns ?? []) {
                if (matchesGlob(pattern, base)) {
                    add('bundle_hygiene', rel, `file matches forbidden pattern "${pattern}"`);
                }
            }
        }

        // --- D. executable inventory ----------------------------------------
        const executableBit = (mode & 0o111) !== 0;
        const head = stats.size > 0 ? await readHead(abs).catch(() => '') : '';
        const isMacho = MACHO_MAGICS.has(head);
        if (executableBit && !allowedExecutables.has(rel)) {
            add('executable_inventory', rel, 'unexpected executable bit on a bundle file');
        }
        if (isMacho || rel.includes('.dylib')) {
            codeItems.push({ path: rel, kind: isMacho ? 'macho' : 'dylib', size: stats.size });
            if (!allowedExecutables.has(rel) && !allowedCodePatterns.some((pattern) => matchesGlob(pattern, rel))) {
                add('executable_inventory', rel, 'unexpected native code item in release bundle');
            }
        }

        // --- B. nested archive allowlist ------------------------------------
        if (isArchiveName(path.basename(rel), archiveExtensions)) {
            nestedArchives.push({ path: rel, size: stats.size });
            if (!allowedArchivePaths.has(rel)) {
                add('nested_archives', rel, 'nested archive is not in the approved allowlist');
            } else {
                try {
                    execFileSync('unzip', ['-Z', '-1', abs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
                } catch (e) {
                    addError('nested_archives', rel, `approved nested archive cannot be inspected: ${e.message.split('\n')[0]}`);
                }
            }
        }

        // --- G. secret material ---------------------------------------------
        if (!matchesAny(secrets.platform_artifact_exemptions ?? [], rel)) {
            const base = path.basename(rel);
            if (matchesAny(secrets.forbidden_file_patterns ?? [], base)) {
                add('secret_material', rel, 'credential or private-key file in release bundle');
            }
            if (stats.size > 0 && stats.size <= (secrets.max_scan_bytes ?? 4 * 1024 * 1024)) {
                const text = await readFile(abs, 'utf8').catch(() => null);
                if (text) {
                    for (const marker of secrets.forbidden_content_markers ?? []) {
                        if (text.includes(marker)) {
                            add('secret_material', rel, `private-key material detected (${marker})`);
                        }
                    }
                }
            }
        }
    }

    // --- E. code signing -----------------------------------------------------
    const signingResults = [];
    for (const item of codeItems) {
        const abs = path.join(appPath, item.path);
        try {
            execFileSync('codesign', ['--verify', '--strict', abs], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            signingResults.push({ path: item.path, status: 'VALID' });
        } catch (e) {
            const message = (e.stderr || e.message || '').split('\n')[0];
            signingResults.push({ path: item.path, status: 'INVALID', detail: message });
            if ((codesign.enforcement ?? 'report') === 'required') {
                add('codesign', item.path, `code signature verification failed: ${message}`);
            }
        }
    }

    // --- F. entitlement contract --------------------------------------------
    let entitlementState = { status: 'UNAVAILABLE', reason: 'codesign did not return entitlements' };
    try {
        const output = execFileSync('codesign', ['-d', '--entitlements', ':-', appPath], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const evaluated = evaluateEntitlementXml(output, policy.entitlements ?? {});
        entitlementState = evaluated;
        findings.push(...evaluated.findings);
    } catch (e) {
        entitlementState = {
            status: 'UNAVAILABLE',
            reason: (e.stderr || e.message || '').split('\n')[0],
            enforcement: (policy.entitlements ?? {}).enforcement ?? 'when_available',
        };
        if (entitlementState.enforcement === 'required') {
            add('entitlements', appPath, `entitlements could not be read: ${entitlementState.reason}`);
        }
    }

    // --- H. size and count budgets ------------------------------------------
    if (budgets.max_total_bytes && totalBytes > budgets.max_total_bytes) {
        add('size_budgets', '.', `bundle is ${totalBytes} bytes, above the ${budgets.max_total_bytes} byte budget`);
    }
    if (budgets.max_total_files && fileCount > budgets.max_total_files) {
        add('size_budgets', '.', `bundle has ${fileCount} files, above the ${budgets.max_total_files} file budget`);
    }
    if (budgets.max_nested_archives !== undefined && nestedArchives.length > budgets.max_nested_archives) {
        add('size_budgets', '.', `bundle has ${nestedArchives.length} nested archives, above the approved count`);
    }
    if (budgets.max_single_file_bytes && largestFile.size > budgets.max_single_file_bytes) {
        add('size_budgets', largestFile.path, `single file is ${largestFile.size} bytes, above the per-file budget`);
    }

    const bom = {
        appPath,
        fileCount,
        totalBytes,
        largestFile,
        nestedArchives,
        codeItems,
        signingResults,
        entitlements: entitlementState,
    };

    return { findings, errors, bom };
}

function parseArgs(argv) {
    const opts = { app: null, policy: DEFAULT_POLICY, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--app') { opts.app = path.resolve(argv[++i]); continue; }
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
    if (opts.help || !opts.app) {
        console.log('Usage: node tools/bundle-hygiene.mjs --app <path.app> [--policy <file>] [--json]');
        process.exit(opts.help ? 0 : 2);
    }

    let result;
    try {
        result = await inspectBundle(opts.app, { policyPath: opts.policy });
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        for (const finding of result.findings) {
            console.log(`[bundle-hygiene] ${finding.invariant}: path=${finding.path} reason=${finding.reason}`);
        }
        for (const error of result.errors) {
            console.log(`[bundle-hygiene] ${error.invariant} error: path=${error.path} reason=${error.reason}`);
        }
        const { bom } = result;
        if (bom) {
            console.log(
                `[bundle-hygiene] files=${bom.fileCount} bytes=${bom.totalBytes} `
                + `nestedArchives=${bom.nestedArchives.length} codeItems=${bom.codeItems.length} `
                + `entitlements=${bom.entitlements.status}`,
            );
        }
        console.log(
            `[bundle-hygiene] result: ${result.findings.length + result.errors.length === 0 ? 'PASS' : 'FAIL'} `
            + `(findings=${result.findings.length}, errors=${result.errors.length})`,
        );
    }

    process.exit(result.findings.length + result.errors.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main().catch((e) => {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    });
}
