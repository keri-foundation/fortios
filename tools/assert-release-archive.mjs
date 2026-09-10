#!/usr/bin/env node

/**
 * Release archive verifier for Fort-ios.
 *
 * Verifies that a genuine Release `.xcarchive` contains the validated
 * production FortWeb payload and excludes development-only material.
 *
 * The archive — not the source tree — is the subject under test.
 *
 * Hard gates (fail closed, exit 1):
 *   1. archive structure (Info.plist + Products/Applications/<app>)
 *   2. app executable present
 *   3. WebPayload manifest present in the app bundle
 *   4. producer manifest identity (fortweb / offline-runtime / app/index.html)
 *   5. runtime-requirements contract present and structurally valid
 *   6. byte identity between the staged payload and the archived payload
 *      (and optionally the built .app payload), including symlink rejection
 *   7. release sanitization — the app bundle outside WebPayload must contain
 *      only native resources allowed by the release policy
 *   8. delegated payload validators (unless --skip-delegated-validators):
 *      assert-payload-integrity, validate-mobile-payload, assert-pyodide-runtime,
 *      validate-runtime-requirements-compatibility
 *   9. release content gate — App Store-incompatible material must be absent
 *      from the archived payload, inspected down to nested ZIP members (for
 *      example the Pyodide python_stdlib.zip). A nested archive that cannot be
 *      inspected fails the gate closed. Ownership note: when a finding is
 *      reported, the fix belongs to the canonical producer pipeline, not to a
 *      rewrite of the archived bytes.
 *
 * Non-fatal audit (reported, not a hard gate):
 *   offline runtime closure — CDN/localhost/file:///source-path markers in the
 *   runtime payload. The pinned producer currently carries known debt here;
 *   the Swift layer's deny-all network policy is the enforcement boundary.
 *
 * Two lanes:
 *
 *   PR lane (default)
 *     Enforces every wrapper-owned invariant and reports producer-owned
 *     findings without enforcing them, because this repository cannot fix
 *     defects inside canonical producer payload bytes. A PR-lane pass is never
 *     a release certification.
 *
 *   Release certification (--release-certification)
 *     Enforces every invariant, including the producer-owned ones named in the
 *     release policy. Only this lane can print CERTIFIED.
 *
 * Usage:
 *   node tools/assert-release-archive.mjs --archive <path.xcarchive>
 *     [--reference-payload <dir>] [--built-app <path.app>]
 *     [--config <runtime-platform-config.json>] [--policy <file>]
 *     [--release-certification] [--evidence <path.json>]
 *
 * Exit codes:
 *   0 — archive verified for the selected lane (no enforcing violations)
 *   1 — enforcing violation
 *   2 — tool error (missing archive, unreadable files, etc.)
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanForbiddenContent } from './scan-release-content.mjs';
import { inspectBundle } from './bundle-hygiene.mjs';
import { evaluateSubmissionMetadata, loadPlist } from './submission-metadata.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_PAYLOAD = path.join(REPO_ROOT, 'WebPayload');
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'runtime-platform-config.json');
const DEFAULT_POLICY = path.join(__dirname, 'release-sanitization-policy.json');

const EXPECTED_PRODUCER = 'fortweb';
const EXPECTED_PROFILE = 'offline-runtime';
const EXPECTED_ENTRYPOINT = 'app/index.html';
const CONTRACT_DESCRIPTOR_PATH = 'contracts/runtime-requirements.json';

// --- helpers -------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        archive: null,
        referencePayload: DEFAULT_PAYLOAD,
        builtApp: null,
        config: DEFAULT_CONFIG,
        policy: DEFAULT_POLICY,
        skipDelegatedValidators: false,
        releaseCertification: false,
        evidence: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--archive') { opts.archive = path.resolve(argv[++i]); continue; }
        if (arg === '--reference-payload') { opts.referencePayload = path.resolve(argv[++i]); continue; }
        if (arg === '--built-app') { opts.builtApp = path.resolve(argv[++i]); continue; }
        if (arg === '--config') { opts.config = path.resolve(argv[++i]); continue; }
        if (arg === '--policy') { opts.policy = path.resolve(argv[++i]); continue; }
        if (arg === '--skip-delegated-validators') { opts.skipDelegatedValidators = true; continue; }
        if (arg === '--release-certification') { opts.releaseCertification = true; continue; }
        if (arg === '--evidence') { opts.evidence = path.resolve(argv[++i]); continue; }
        throw new Error(`unknown argument: ${arg}`);
    }
    if (!opts.archive) throw new Error('--archive is required');
    return opts;
}

function toolError(message) {
    process.stderr.write(`[release-archive] TOOL ERROR: ${message}\n`);
    process.exit(2);
}

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function globToRegex(pattern) {
    let out = '';
    for (const ch of pattern) {
        if (ch === '*') {
            out += '.*';
        } else if (ch === '?') {
            out += '.';
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

function matchesAny(name, patterns) {
    return patterns.some((p) => globToRegex(p).test(name));
}

async function listTree(root) {
    // Returns a map of relative path (posix) -> { sha256, bytes }, rejecting symlinks.
    const result = new Map();

    async function walk(dir, prefix) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT') throw new Error(`directory missing: ${dir}`);
            throw err;
        }
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

            const st = await lstat(absPath);
            if (st.isSymbolicLink()) {
                result.set(`__symlink__:${relPath}`, { symlink: true });
                continue;
            }
            if (entry.isDirectory()) {
                await walk(absPath, relPath);
            } else if (entry.isFile()) {
                const buf = await readFile(absPath);
                result.set(relPath, { sha256: sha256(buf), bytes: buf.length });
            }
        }
    }

    await walk(root, '');
    return result;
}

function violation(kind, target, reason, expected) {
    return { kind, target, reason, expected };
}

/** Deterministic digest of a directory tree, used for release evidence. */
async function digestTree(root) {
    const tree = await listTree(root);
    const hash = createHash('sha256');
    let fileCount = 0;
    let totalBytes = 0;

    for (const relPath of [...tree.keys()].sort()) {
        const entry = tree.get(relPath);
        if (entry.symlink) {
            hash.update(`symlink\0${relPath}\n`);
            continue;
        }
        hash.update(`${relPath}\0${entry.sha256}\n`);
        fileCount += 1;
        totalBytes += entry.bytes;
    }

    return { sha256: hash.digest('hex'), fileCount, totalBytes };
}

/** Source commit the run was produced from; null when Git is unavailable. */
async function currentCommitSha() {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
        return stdout.trim();
    } catch {
        return null;
    }
}

// --- structural checks ---------------------------------------------------

async function locateApp(archivePath, policy) {
    const expected = policy.archive.expected_app_name;
    const productsDir = path.join(archivePath, policy.archive.products_subpath);

    const infoPlist = path.join(archivePath, 'Info.plist');
    try {
        const st = await lstat(infoPlist);
        if (!st.isFile()) return { errors: [violation('archive', infoPlist, 'archive Info.plist is not a regular file', 'archive must contain Info.plist')], appPath: null };
    } catch {
        return { errors: [violation('archive', infoPlist, 'archive Info.plist missing', 'archive must contain Info.plist')], appPath: null };
    }

    const appPath = path.join(productsDir, expected);
    try {
        const st = await lstat(appPath);
        if (!st.isDirectory()) return { errors: [violation('archive', appPath, 'archived application is not a directory', `expected ${expected} under ${policy.archive.products_subpath}`)], appPath: null };
    } catch {
        return { errors: [violation('archive', appPath, 'archived application missing', `expected ${expected} under ${policy.archive.products_subpath}`)], appPath: null };
    }

    return { errors: [], appPath };
}

async function checkExecutable(appPath, policy) {
    const errors = [];
    const exePath = path.join(appPath, policy.app_bundle.executable_name);
    try {
        const st = await lstat(exePath);
        if (!st.isFile()) {
            errors.push(violation('app', exePath, 'app executable is not a regular file', 'archived app must contain its Mach-O executable'));
        }
    } catch {
        errors.push(violation('app', exePath, 'app executable missing', 'archived app must contain its Mach-O executable'));
    }
    return errors;
}

async function readPayloadManifest(payloadRoot) {
    const manifestPath = path.join(payloadRoot, 'manifest.json');
    let text;
    try {
        text = await readFile(manifestPath, 'utf8');
    } catch {
        return { errors: [violation('payload', manifestPath, 'producer manifest missing', 'archived payload must contain manifest.json')], manifest: null };
    }
    try {
        return { errors: [], manifest: JSON.parse(text) };
    } catch {
        return { errors: [violation('payload', manifestPath, 'producer manifest is malformed JSON', 'manifest.json must be valid JSON')], manifest: null };
    }
}

function checkManifestIdentity(manifest) {
    const errors = [];
    const expected = 'Producer manifest must declare fortweb / offline-runtime / app/index.html.';
    if (manifest.producer !== EXPECTED_PRODUCER) {
        errors.push(violation('payload', 'manifest.json', `producer mismatch: expected ${EXPECTED_PRODUCER}, got ${manifest.producer}`, expected));
    }
    if (manifest.payload_profile !== EXPECTED_PROFILE) {
        errors.push(violation('payload', 'manifest.json', `payload_profile mismatch: expected ${EXPECTED_PROFILE}, got ${manifest.payload_profile}`, expected));
    }
    if (manifest.entrypoint !== EXPECTED_ENTRYPOINT) {
        errors.push(violation('payload', 'manifest.json', `entrypoint mismatch: expected ${EXPECTED_ENTRYPOINT}, got ${manifest.entrypoint}`, expected));
    }
    return errors;
}

async function checkContractArtifact(payloadRoot, manifest, policy) {
    // Structural contract presence + schema check (distinct from full
    // compatibility, which is delegated to validate-runtime-requirements-compatibility).
    const errors = [];
    const descriptor = manifest?.contracts?.runtime_requirements;
    const descriptorPath = descriptor?.path;
    if (typeof descriptorPath !== 'string' || descriptorPath.length === 0) {
        errors.push(violation('contract', 'manifest.json', 'manifest.contracts.runtime_requirements.path is missing', 'producer manifest must declare the runtime-requirements descriptor'));
        return errors;
    }
    if (descriptorPath !== CONTRACT_DESCRIPTOR_PATH) {
        errors.push(violation('contract', descriptorPath, `unexpected descriptor path: ${descriptorPath}`, `expected ${CONTRACT_DESCRIPTOR_PATH}`));
        return errors;
    }

    const contractPath = path.join(payloadRoot, descriptorPath);
    let text;
    try {
        text = await readFile(contractPath, 'utf8');
    } catch {
        errors.push(violation('contract', descriptorPath, 'runtime-requirements contract missing', `${CONTRACT_DESCRIPTOR_PATH} must be present in the archived payload`));
        return errors;
    }

    let contract;
    try {
        contract = JSON.parse(text);
    } catch {
        errors.push(violation('contract', descriptorPath, 'runtime-requirements contract is malformed JSON', 'contract must be valid JSON'));
        return errors;
    }

    if (contract.schema !== policy.contract.requirements_schema) {
        errors.push(violation('contract', descriptorPath, `contract schema mismatch: expected ${policy.contract.requirements_schema}, got ${contract.schema}`, 'contract must declare the supported requirements schema'));
    }
    if (contract.version !== policy.contract.requirements_version) {
        errors.push(violation('contract', descriptorPath, `contract version mismatch: expected ${policy.contract.requirements_version}, got ${contract.version}`, 'contract must declare the supported requirements version'));
    }
    return errors;
}

// --- byte identity -------------------------------------------------------

function compareTrees(referenceTree, subjectTree, subjectLabel) {
    const errors = [];
    const expected = `Every reference payload file must be byte-identical in ${subjectLabel}, with no extra or symlinked entries.`;

    for (const [relPath, meta] of referenceTree) {
        if (meta.symlink) {
            errors.push(violation('identity', relPath, `reference payload contains a symlink: ${relPath}`, expected));
            continue;
        }
        const subject = subjectTree.get(relPath);
        if (!subject) {
            errors.push(violation('identity', relPath, `file missing from ${subjectLabel}`, expected));
            continue;
        }
        if (subject.symlink) {
            errors.push(violation('identity', relPath, `file replaced by symlink in ${subjectLabel}`, expected));
            continue;
        }
        if (subject.sha256 !== meta.sha256) {
            errors.push(violation('identity', relPath, `SHA-256 mismatch in ${subjectLabel}: expected ${meta.sha256}, got ${subject.sha256}`, expected));
        }
        if (subject.bytes !== meta.bytes) {
            errors.push(violation('identity', relPath, `byte size mismatch in ${subjectLabel}: expected ${meta.bytes}, got ${subject.bytes}`, expected));
        }
    }

    for (const [relPath, meta] of subjectTree) {
        if (meta.symlink) {
            errors.push(violation('identity', relPath, `unexpected symlink in ${subjectLabel}`, expected));
            continue;
        }
        if (!referenceTree.has(relPath)) {
            errors.push(violation('identity', relPath, `unexpected file in ${subjectLabel}`, expected));
        }
    }

    return errors;
}

// --- sanitization --------------------------------------------------------

async function sanitizeAppBundle(appPath, payloadSubdirectory, policy) {
    const errors = [];
    const expected = 'App bundle outside WebPayload must contain only native resources allowed by the release policy.';

    const topEntries = await readdir(path.join(appPath), { withFileTypes: true });

    for (const entry of topEntries) {
        const abs = path.join(appPath, entry.name);
        const isDir = entry.isDirectory();

        if (entry.name === payloadSubdirectory) {
            if (!isDir) {
                errors.push(violation('sanitize', entry.name, 'WebPayload must be a directory', expected));
            }
            continue; // payload subtree governed by manifest + byte identity
        }

        if (matchesAny(entry.name, policy.app_bundle.allowed_top_level_file_patterns) && !isDir) {
            continue;
        }
        if (policy.app_bundle.allowed_top_level_files.includes(entry.name) && !isDir) {
            continue;
        }
        if (matchesAny(entry.name, policy.app_bundle.allowed_top_level_directory_patterns) && isDir) {
            errors.push(...(await sanitizeLocalizedDirectory(abs, policy)));
            continue;
        }
        if (policy.app_bundle.allowed_top_level_directories.includes(entry.name) && isDir) {
            if (entry.name === '_CodeSignature') {
                errors.push(...(await sanitizeSignatureDirectory(abs, policy)));
            }
            // Frameworks subtree is native packaging; WebPayload is skipped above.
            continue;
        }

        errors.push(violation('sanitize', entry.name, 'unexpected bundle entry', expected));
    }

    return errors;
}

async function sanitizeLocalizedDirectory(dir, policy) {
    const errors = [];
    const expected = 'Localized (.lproj) directories must contain only compiled storyboards and string resources.';
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const allowed = policy.app_bundle.localized_directory_allowed_entries;
        if (matchesAny(entry.name, allowed)) continue;
        errors.push(violation('sanitize', `${path.basename(dir)}/${entry.name}`, 'unexpected localized resource', expected));
    }
    return errors;
}

async function sanitizeSignatureDirectory(dir, policy) {
    const errors = [];
    const expected = '_CodeSignature must contain only OS-generated signature material.';
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const allowed = policy.app_bundle.signature_directory_allowed_entries;
        if (allowed.includes(entry.name)) continue;
        if (entry.name.startsWith('CodeRequirements')) continue;
        errors.push(violation('sanitize', `_CodeSignature/${entry.name}`, 'unexpected signature entry', expected));
    }
    return errors;
}

// --- offline closure audit (non-fatal) -----------------------------------

async function auditOfflineClosure(payloadRoot, policy) {
    const findings = [];
    const cfg = policy.offline_closure;
    const exts = new Set(cfg.scan_extensions);
    const exclude = new Set(cfg.exclude_files);

    async function walk(dir, prefix) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absPath, relPath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (exclude.has(relPath) || exclude.has(entry.name)) continue;
            if (!exts.has(path.extname(entry.name))) continue;

            const text = await readFile(absPath, 'utf8');
            for (const marker of cfg.forbidden_markers) {
                if (text.includes(marker.pattern)) {
                    findings.push({ file: relPath, marker: marker.pattern, reason: marker.reason });
                }
            }
        }
    }

    await walk(payloadRoot, '');
    return findings;
}

// --- delegated validators ------------------------------------------------

/**
 * Collect first-party native sources named by the required-reason scan policy so
 * observed API usage can be compared against privacy-manifest declarations.
 */
async function collectRequiredReasonSources(scanPolicy) {
    const root = path.join(REPO_ROOT, scanPolicy.source_root ?? '');
    const extensions = scanPolicy.source_extensions ?? [];
    const sources = {};

    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
            sources[path.relative(REPO_ROOT, abs)] = await readFile(abs, 'utf8');
        }
    }

    await walk(root);
    return sources;
}

/**
 * Evaluate the declaration surfaces of the archived application: the bundled
 * privacy manifest, the final generated Info.plist, and first-party API usage.
 */
async function evaluateBundleSubmissionMetadata(appPath, policy) {
    const section = policy.submission_metadata ?? {};
    const manifestPath = path.join(appPath, section.privacy_manifest?.filename ?? 'PrivacyInfo.xcprivacy');
    const infoPlistPath = path.join(appPath, 'Info.plist');

    let privacyManifest;
    try {
        privacyManifest = await loadPlist(manifestPath);
    } catch (e) {
        throw new Error(`privacy manifest is missing or unreadable at ${manifestPath}: ${e.message.split('\n')[0]}`);
    }

    let infoPlist;
    try {
        infoPlist = await loadPlist(infoPlistPath);
    } catch (e) {
        throw new Error(`Info.plist is missing or unreadable at ${infoPlistPath}: ${e.message.split('\n')[0]}`);
    }

    const sources = await collectRequiredReasonSources(section.privacy_manifest?.required_reason_scan ?? {});

    return evaluateSubmissionMetadata({ privacyManifest, infoPlist, sources, policy: section });
}

async function runDelegatedValidator(script, args) {
    try {
        const { stdout, stderr } = await execFileAsync('node', [script, ...args], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, stdout, stderr };
    } catch (err) {
        return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', message: err.message };
    }
}

async function runDelegatedValidators(payloadRoot, config) {
    const results = [];
    const specs = [
        { name: 'payload-integrity', script: path.join(__dirname, 'assert-payload-integrity.mjs'), args: ['--payload-dir', payloadRoot] },
        { name: 'mobile-payload', script: path.join(__dirname, 'validate-mobile-payload.mjs'), args: ['--payload-dir', payloadRoot, '--target', 'ios-webpayload'] },
        { name: 'pyodide-runtime', script: path.join(__dirname, 'assert-pyodide-runtime.mjs'), args: ['--payload-dir', payloadRoot] },
        { name: 'requirements-compatibility', script: path.join(__dirname, 'validate-runtime-requirements-compatibility.mjs'), args: ['--payload', payloadRoot, '--config', config] },
    ];
    for (const spec of specs) {
        results.push({ name: spec.name, ...(await runDelegatedValidator(spec.script, spec.args)) });
    }
    return results;
}

// --- main ----------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    let policy;
    try {
        policy = JSON.parse(await readFile(opts.policy, 'utf8'));
    } catch (err) {
        toolError(`Cannot read release policy at ${opts.policy}: ${err.message}`);
    }

    console.log(`[release-archive] archive: ${opts.archive}`);
    console.log(`[release-archive] reference payload: ${opts.referencePayload}`);
    console.log(`[release-archive] policy: ${opts.policy}`);

    const lane = opts.releaseCertification ? 'release-certification' : 'pr';
    const producerOwnedKinds = new Set(Object.keys(policy.producer_owned?.invariants ?? {}));
    const producerOwner = policy.producer_owned?.owning_party ?? 'upstream-producer';
    console.log(`[release-archive] lane: ${lane}`);
    console.log(`[release-archive] producer-owned invariants (owner=${producerOwner}): ${
        producerOwnedKinds.size > 0 ? [...producerOwnedKinds].join(', ') : 'none'
    }`);

    const hardErrors = [];
    const producerDebt = [];

    /**
     * Route a violation to the lane that owns it. Producer-owned invariants are
     * reported in the PR lane and enforced in release certification; they are
     * never silenced.
     */
    const record = (kind, target, reason, expected) => {
        const entry = violation(kind, target, reason, expected);
        if (lane === 'pr' && producerOwnedKinds.has(kind)) {
            producerDebt.push(entry);
        } else {
            hardErrors.push(entry);
        }
        return entry;
    };

    const laneInfo = () => ({
        lane,
        certified: lane === 'release-certification' && hardErrors.length === 0,
        producerDebt: producerDebt.length,
        producerOwner,
    });

    // 1. Archive structure
    const { errors: locErrors, appPath } = await locateApp(opts.archive, policy);
    hardErrors.push(...locErrors);
    if (!appPath) {
        printViolations(hardErrors);
        finish(false, null, laneInfo());
        return;
    }
    console.log(`[release-archive] archived app located: ${appPath}`);

    // 2. Executable
    hardErrors.push(...(await checkExecutable(appPath, policy)));

    // 3. Payload root
    const payloadRoot = path.join(appPath, policy.app_bundle.payload_subdirectory);
    console.log(`[release-archive] archived payload located: ${payloadRoot}`);

    // 4. Manifest identity (own check)
    const { errors: manifestReadErrors, manifest } = await readPayloadManifest(payloadRoot);
    hardErrors.push(...manifestReadErrors);
    if (manifest) {
        hardErrors.push(...checkManifestIdentity(manifest));
    }

    // 5. Contract artifact (own structural check)
    if (manifest) {
        hardErrors.push(...(await checkContractArtifact(payloadRoot, manifest, policy)));
    }

    // 6. Byte identity (reference vs archived)
    let referenceTree;
    try {
        referenceTree = await listTree(opts.referencePayload);
    } catch (err) {
        toolError(`Cannot read reference payload at ${opts.referencePayload}: ${err.message}`);
    }
    const archivedTree = await listTree(payloadRoot);
    hardErrors.push(...compareTrees(referenceTree, archivedTree, 'archived payload'));

    if (opts.builtApp) {
        const builtPayloadRoot = path.join(opts.builtApp, policy.app_bundle.payload_subdirectory);
        const builtTree = await listTree(builtPayloadRoot);
        hardErrors.push(...compareTrees(referenceTree, builtTree, 'built app payload'));
        hardErrors.push(...compareTrees(builtTree, archivedTree, 'archived payload'));
        console.log(`[release-archive] built app payload compared: ${builtPayloadRoot}`);
    }

    // 7. Sanitization
    hardErrors.push(...(await sanitizeAppBundle(appPath, policy.app_bundle.payload_subdirectory, policy)));

    // 8. Delegated validators (optional for isolated unit tests)
    let delegatedResults = null;
    if (!opts.skipDelegatedValidators) {
        delegatedResults = await runDelegatedValidators(payloadRoot, opts.config);
        for (const r of delegatedResults) {
            console.log(`[release-archive] delegated ${r.name}: ${r.ok ? 'PASS' : 'FAIL'}`);
            if (!r.ok) {
                hardErrors.push(violation('delegated', r.name, `delegated validator failed: ${r.name}`, `${r.name} must pass against the archived payload`));
            }
        }
    } else {
        console.log('[release-archive] delegated validators skipped (--skip-delegated-validators)');
    }

    // Submission metadata (hard + advisory): what the app declares to iOS and
    // Apple versus what it actually ships.
    let submissionReport = null;
    try {
        submissionReport = await evaluateBundleSubmissionMetadata(appPath, policy);
        for (const finding of submissionReport.findings) {
            console.log(`[release-archive] ${finding.invariant} finding: path=${finding.path} reason=${finding.reason}`);
            hardErrors.push(violation(finding.invariant, finding.path, finding.reason, 'Submission declarations must match the shipped build'));
        }
        for (const advisory of submissionReport.advisories) {
            console.log(`[release-archive] advisory (${advisory.invariant}): path=${advisory.path} reason=${advisory.reason}`);
        }
    } catch (err) {
        hardErrors.push(violation(
            'submission_metadata',
            'policy',
            `submission metadata gate could not run: ${err.message}`,
            'Declaration surfaces must be inspectable for every release archive',
        ));
    }

    // Structural bundle hygiene (hard): closed-world contracts for the final
    // application bundle. Unknown structure is denied rather than enumerated.
    let bundleReport = null;
    try {
        const hygiene = await inspectBundle(appPath, { policyPath: opts.policy });
        bundleReport = hygiene.bom;
        for (const finding of hygiene.findings) {
            console.log(`[release-archive] ${finding.invariant} finding: path=${finding.path} reason=${finding.reason}`);
            hardErrors.push(violation(finding.invariant, finding.path, finding.reason, 'Final bundle must satisfy the structural release policy'));
        }
        for (const error of hygiene.errors) {
            console.log(`[release-archive] ${error.invariant} inspection error: path=${error.path} reason=${error.reason}`);
            hardErrors.push(violation(error.invariant, error.path, error.reason, 'Bundle inspection must succeed; an uninspectable bundle cannot be certified'));
        }
    } catch (err) {
        hardErrors.push(violation(
            'bundle_hygiene',
            'policy',
            `bundle hygiene gate could not run: ${err.message}`,
            'The structural bundle gate must run against every release archive',
        ));
    }

    // Release content gate (hard): forbidden App Store-incompatible material
    // must be absent from the archived payload, including inside nested
    // archives such as the Pyodide python_stdlib.zip.
    let releaseContentResult = null;
    try {
        releaseContentResult = await scanForbiddenContent(payloadRoot, { policyPath: opts.policy });
        for (const finding of releaseContentResult.findings) {
            console.log(`[release-archive] release-content finding: file=${finding.file} marker=${finding.marker}`);
            record(
                'release-content',
                finding.file,
                `forbidden release content "${finding.marker}": ${finding.reason}`,
                'Archived payload must not contain release-gate forbidden content; the canonical runtime producer owns the fix',
            );
        }
        for (const error of releaseContentResult.errors) {
            console.log(`[release-archive] release-content inspection error: file=${error.file} reason=${error.reason}`);
            // Inspection failures are always enforcing: an archive that cannot
            // be inspected can never be waved through by either lane.
            hardErrors.push(violation(
                'release-content-inspection',
                error.file,
                `release content could not be inspected: ${error.reason}`,
                'Nested archive inspection must succeed; an uninspectable archive cannot be certified clean',
            ));
        }
    } catch (err) {
        hardErrors.push(violation(
            'release-content',
            'policy',
            `release content gate could not run: ${err.message}`,
            'The release content gate must run against every release archive',
        ));
    }

    // Offline closure audit: producer-owned, reported in the PR lane and
    // enforced during release certification.
    const offlineFindings = await auditOfflineClosure(payloadRoot, policy);
    const offlinePass = offlineFindings.length === 0;
    console.log(`[release-archive] offline-closure findings: ${offlineFindings.length}`);
    for (const f of offlineFindings) {
        console.log(`[release-archive] offline-closure finding: file=${f.file} marker=${f.marker} reason=${f.reason}`);
        record(
            'offline-closure',
            f.file,
            `offline runtime dependency "${f.marker}": ${f.reason}`,
            'Runtime payload must be closed over offline resources without CDN, loopback, or source-checkout dependencies',
        );
    }
    console.log(`[release-archive] offline-closure invariant: ${offlinePass
        ? 'PASS'
        : lane === 'pr'
            ? 'FAIL (producer-owned debt — reported, not enforced in the PR lane)'
            : 'FAIL (enforced by release certification)'}`);

    printViolations(hardErrors);

    if (producerDebt.length > 0) {
        console.log(`[release-archive] producer-owned findings not enforced in this lane: ${producerDebt.length} (owner=${producerOwner})`);
        for (const entry of producerDebt) {
            console.log(`  kind=${entry.kind} target=${entry.target}`);
        }
        console.log('[release-archive] a PR-lane pass is not a release certification; run --release-certification to enforce these');
    }

    const passed = hardErrors.length === 0;
    const summary = {
        archive: opts.archive,
        appPath,
        payloadRoot,
        offlineClosurePass: offlinePass,
        offlineClosureFindings: offlineFindings.length,
        releaseContentFindings: releaseContentResult ? releaseContentResult.findings.length : null,
        releaseContentScannedFiles: releaseContentResult ? releaseContentResult.scannedFiles : null,
        releaseContentInspectedArchives: releaseContentResult ? releaseContentResult.inspectedArchives : null,
        bundle: bundleReport
            ? {
                fileCount: bundleReport.fileCount,
                totalBytes: bundleReport.totalBytes,
                nestedArchives: bundleReport.nestedArchives.map((entry) => entry.path),
                codeItems: bundleReport.codeItems.map((entry) => entry.path),
                signing: bundleReport.signingResults,
                entitlementKeys: bundleReport.entitlements.keys ?? null,
                entitlementStatus: bundleReport.entitlements.status,
            }
            : null,
        submission: submissionReport ? submissionReport.details : null,
        delegatedResults,
    };

    if (opts.evidence) {
        const archiveDigest = await digestTree(opts.archive);
        await mkdir(path.dirname(opts.evidence), { recursive: true });
        await writeFile(opts.evidence, `${JSON.stringify({
            schema: 'fort.ios-release-evidence.v1',
            lane,
            result: passed ? 'PASS' : 'FAIL',
            certified: lane === 'release-certification' && passed,
            sourceCommitSha: await currentCommitSha(),
            archivePath: opts.archive,
            archiveSha256: archiveDigest.sha256,
            archiveFileCount: archiveDigest.fileCount,
            archiveTotalBytes: archiveDigest.totalBytes,
            policyPath: opts.policy,
            producerOwner: producerOwnedKinds.size > 0 ? producerOwner : null,
            violations: hardErrors,
            producerOwnedFindings: producerDebt,
            summary,
        }, null, 2)}\n`);
        console.log(`[release-archive] evidence written: ${opts.evidence}`);
    }

    finish(passed, summary, { ...laneInfo(), certified: lane === 'release-certification' && passed });
}

function printViolations(errors) {
    for (const e of errors) {
        console.log('[release-archive] violation');
        console.log(`  kind: ${e.kind}`);
        console.log(`  target: ${e.target}`);
        console.log(`  reason: ${e.reason}`);
        console.log(`  expected: ${e.expected}`);
    }
}

function finish(passed, summary, lane = {}) {
    console.log(`[release-archive] result: ${passed ? 'PASS' : 'FAIL'}`);
    console.log(`[release-archive] lane: ${lane.lane ?? 'pr'}`);

    if (!passed) {
        console.log('[release-archive] certification: NOT_CERTIFIED');
        process.exitCode = 1;
        return;
    }

    if (lane.certified) {
        console.log('[release-archive] certification: CERTIFIED');
    } else if (lane.producerDebt > 0) {
        console.log(`[release-archive] certification: NOT_CERTIFIED (${lane.producerDebt} producer-owned finding(s) reported, owner=${lane.producerOwner})`);
    } else {
        console.log('[release-archive] certification: NOT_CERTIFIED (PR lane never certifies a release; run --release-certification)');
    }

    if (summary) {
        console.log('[release-archive] summary');
        console.log(`  archived app located: ${summary.appPath}`);
        console.log(`  archived payload located: ${summary.payloadRoot}`);
        console.log(`  manifest validated: true`);
        console.log(`  contract validated: true`);
        console.log(`  byte identity validated: true`);
        console.log(`  sanitization passed: true`);
        console.log(`  offline-closure invariant: ${summary.offlineClosurePass ? 'PASS' : 'FAIL (producer-owned debt)'}`);
    }
}

main().catch((err) => {
    toolError(err instanceof Error ? err.message : String(err));
});
