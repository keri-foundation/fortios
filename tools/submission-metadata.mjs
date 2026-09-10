#!/usr/bin/env node

/**
 * App Store submission-metadata validator.
 *
 * The binary containment layers (release content, bundle structure) answer
 * "what bytes ship?". This validator answers the next question:
 *
 *   "what does the app declare to iOS and Apple, and does that declaration
 *    match what it actually ships?"
 *
 * Boundaries:
 *   A. privacy manifest structure and semantics (PrivacyInfo.xcprivacy)
 *   B. required-reason API declaration coverage (static source scan vs manifest)
 *   C. Info.plist capability closure (ATS, permissions, URL schemes, background)
 *   D. export-compliance evidence inventory (reports only; never guesses)
 *
 * Everything here is declarative policy in the single release policy file. The
 * evaluators are pure functions over parsed property lists so they can be tested
 * without Xcode, signing, or a real archive.
 *
 * This module never mutates declarations and never invents compliance answers.
 */

import { execFileSync } from 'node:child_process';

const TRACKING_KEY = 'NSPrivacyTracking';
const TRACKING_DOMAINS_KEY = 'NSPrivacyTrackingDomains';
const COLLECTED_DATA_KEY = 'NSPrivacyCollectedDataTypes';
const ACCESSED_API_KEY = 'NSPrivacyAccessedAPITypes';

const PLIST_MAX_BUFFER = 32 * 1024 * 1024;

// plistlib is Python stdlib and reads both the XML and the binary property-list
// formats, so the Linux PR lane can evaluate the same declarations that macOS
// evaluates with plutil.
const PYTHON_PLIST_READER = [
    'import json, plistlib, sys',
    'with open(sys.argv[1], "rb") as handle:',
    '    print(json.dumps(plistlib.load(handle)))',
].join('\n');

function runPlistReader(command, args) {
    return execFileSync(command, args, {
        encoding: 'utf8',
        maxBuffer: PLIST_MAX_BUFFER,
    });
}

/**
 * Read a property list with python3's stdlib reader.
 *
 * This is the reader used wherever plutil is unavailable (the Linux PR lane).
 */
export function loadPlistWithPython(filePath) {
    return JSON.parse(runPlistReader('python3', ['-c', PYTHON_PLIST_READER, filePath]));
}

/**
 * Read a property list.
 *
 * plutil is Apple's own reader and is used whenever it exists. It is macOS-only,
 * so the fallback keeps the declaration checks running on Linux instead of
 * skipping them. A failure from a reader that is present is a real parse error
 * and is never swallowed.
 */
export function loadPlist(filePath) {
    try {
        return JSON.parse(runPlistReader('plutil', ['-convert', 'json', '-o', '-', filePath]));
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
    return loadPlistWithPython(filePath);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A. Privacy manifest structure and semantics.
 *
 * @param {object} manifest - parsed PrivacyInfo.xcprivacy
 * @param {object} policy - submission_metadata.privacy_manifest
 */
export function evaluatePrivacyManifest(manifest, policy = {}) {
    const findings = [];
    const advisories = [];

    if (!isPlainObject(manifest)) {
        findings.push({ invariant: 'privacy_manifest', path: '.', reason: 'privacy manifest root must be a dictionary' });
        return { findings, advisories, classification: {} };
    }

    const allowed = new Set(policy.allowed_keys ?? []);
    for (const key of Object.keys(manifest)) {
        if (allowed.size > 0 && !allowed.has(key)) {
            findings.push({
                invariant: 'privacy_manifest',
                path: key,
                reason: 'unrecognized key in privacy manifest (Apple defines the closed set of top-level keys)',
            });
        }
    }

    if (manifest[TRACKING_KEY] !== undefined && typeof manifest[TRACKING_KEY] !== 'boolean') {
        findings.push({ invariant: 'privacy_manifest', path: TRACKING_KEY, reason: 'NSPrivacyTracking must be a boolean' });
    }
    const tracking = manifest[TRACKING_KEY] === true;
    const trackingDomains = manifest[TRACKING_DOMAINS_KEY];

    if (trackingDomains !== undefined) {
        if (!Array.isArray(trackingDomains) || trackingDomains.some((entry) => typeof entry !== 'string')) {
            findings.push({
                invariant: 'privacy_manifest',
                path: TRACKING_DOMAINS_KEY,
                reason: 'NSPrivacyTrackingDomains must be an array of strings',
            });
        } else if (!tracking && trackingDomains.length > 0) {
            findings.push({
                invariant: 'privacy_manifest',
                path: TRACKING_DOMAINS_KEY,
                reason: 'tracking domains are declared while NSPrivacyTracking is false',
            });
        }
    }

    // Tracking must be an explicit owner decision, never an accident.
    if ((policy.tracking_expected ?? false) === false) {
        if (tracking) {
            findings.push({
                invariant: 'privacy_manifest',
                path: TRACKING_KEY,
                reason: 'NSPrivacyTracking is true but the approved product position is no tracking',
            });
        }
    } else if (!tracking) {
        advisories.push({
            invariant: 'privacy_manifest',
            path: TRACKING_KEY,
            reason: 'policy expects tracking but the manifest declares none',
        });
    }

    if (manifest[COLLECTED_DATA_KEY] !== undefined && !Array.isArray(manifest[COLLECTED_DATA_KEY])) {
        findings.push({
            invariant: 'privacy_manifest',
            path: COLLECTED_DATA_KEY,
            reason: 'NSPrivacyCollectedDataTypes must be an array',
        });
    }

    const accessed = manifest[ACCESSED_API_KEY];
    const classification = { declared_categories: [], reasons: {} };
    if (accessed === undefined) {
        findings.push({
            invariant: 'privacy_manifest',
            path: ACCESSED_API_KEY,
            reason: 'NSPrivacyAccessedAPITypes is missing',
        });
    } else if (!Array.isArray(accessed)) {
        findings.push({
            invariant: 'privacy_manifest',
            path: ACCESSED_API_KEY,
            reason: 'NSPrivacyAccessedAPITypes must be an array',
        });
    } else {
        const known = policy.known_api_categories ?? {};
        const seen = new Set();
        accessed.forEach((entry, index) => {
            const at = `${ACCESSED_API_KEY}[${index}]`;
            if (!isPlainObject(entry)) {
                findings.push({ invariant: 'privacy_manifest', path: at, reason: 'entry must be a dictionary' });
                return;
            }
            const type = entry.NSPrivacyAccessedAPIType;
            const reasons = entry.NSPrivacyAccessedAPITypeReasons;
            if (typeof type !== 'string' || type.length === 0) {
                findings.push({ invariant: 'privacy_manifest', path: at, reason: 'NSPrivacyAccessedAPIType is missing' });
                return;
            }
            if (seen.has(type)) {
                findings.push({ invariant: 'privacy_manifest', path: type, reason: 'duplicate API category declaration' });
            }
            seen.add(type);
            classification.declared_categories.push(type);

            if (!Array.isArray(reasons) || reasons.length === 0 || reasons.some((r) => typeof r !== 'string')) {
                findings.push({
                    invariant: 'privacy_manifest',
                    path: type,
                    reason: 'NSPrivacyAccessedAPITypeReasons must be a non-empty array of reason strings',
                });
                return;
            }
            classification.reasons[type] = reasons;

            const valid = known[type];
            if (!valid) {
                findings.push({
                    invariant: 'privacy_manifest',
                    path: type,
                    reason: 'unknown required-reason API category (not in Apple\'s published list)',
                });
                return;
            }
            for (const reason of reasons) {
                if (!valid.includes(reason)) {
                    findings.push({
                        invariant: 'privacy_manifest',
                        path: type,
                        reason: `reason code "${reason}" is not an approved reason for this category`,
                    });
                }
            }
        });
    }

    return { findings, advisories, classification };
}

/**
 * B. Required-reason API usage: static pattern scan of first-party sources
 * compared against the manifest's declarations.
 *
 * @param {Record<string,string>} sources - path -> file contents
 * @param {object} manifest
 * @param {object} policy - submission_metadata.privacy_manifest.required_reason_scan
 */
export function auditRequiredReasonApis(sources, manifest, policy = {}) {
    const observed = [];
    for (const [category, spec] of Object.entries(policy.categories ?? {})) {
        const patterns = (spec.patterns ?? []).map((p) => new RegExp(p));
        for (const [file, contents] of Object.entries(sources)) {
            for (const pattern of patterns) {
                if (pattern.test(contents)) {
                    observed.push({ category, pattern: pattern.source, source: file });
                }
            }
        }
    }

    const declared = new Map();
    for (const entry of Array.isArray(manifest?.[ACCESSED_API_KEY]) ? manifest[ACCESSED_API_KEY] : []) {
        if (isPlainObject(entry) && typeof entry.NSPrivacyAccessedAPIType === 'string') {
            declared.set(entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons ?? []);
        }
    }

    const observedCategories = [...new Set(observed.map((o) => o.category))];
    const rows = [];

    for (const category of observedCategories) {
        const reasons = declared.get(category);
        rows.push({
            category,
            observed_usage: observed.filter((o) => o.category === category).map((o) => `${o.source} ~ /${o.pattern}/`),
            declared_reason: reasons ?? null,
            status: reasons ? 'MATCH' : 'MISSING_DECLARATION',
        });
    }
    for (const [category, reasons] of declared) {
        if (!observedCategories.includes(category)) {
            rows.push({
                category,
                observed_usage: [],
                declared_reason: reasons,
                status: 'STALE_DECLARATION',
            });
        }
    }

    const findings = rows
        .filter((row) => row.status === 'MISSING_DECLARATION')
        .map((row) => ({
            invariant: 'required_reason_api',
            path: row.category,
            reason: `source uses this API category but the privacy manifest does not declare it (${row.observed_usage.join('; ')})`,
        }));

    const advisories = rows
        .filter((row) => row.status === 'STALE_DECLARATION')
        .map((row) => ({
            invariant: 'required_reason_api',
            path: row.category,
            reason: 'declared in the privacy manifest but no first-party use was found; needs owner confirmation before removal',
        }));

    return { findings, advisories, rows };
}

const BROAD_ATS_KEYS = [
    'NSAllowsArbitraryLoads',
    'NSAllowsArbitraryLoadsInWebContent',
    'NSAllowsArbitraryLoadsForMedia',
    'NSAllowsArbitraryLoadsInWebContent',
    'NSExceptionAllowsInsecureHTTPLoads',
];

/**
 * C. Info.plist capability closure.
 *
 * @param {object} infoPlist - the final generated Info.plist
 * @param {object} policy - submission_metadata.info_plist
 */
export function evaluateInfoPlist(infoPlist, policy = {}) {
    const findings = [];
    const advisories = [];
    const inventory = {
        ats: infoPlist?.NSAppTransportSecurity ?? null,
        purposeStrings: [],
        urlSchemes: [],
        backgroundModes: infoPlist?.UIBackgroundModes ?? [],
        bonjourServices: infoPlist?.NSBonjourServices ?? [],
        localNetwork: infoPlist?.NSLocalNetworkUsageDescription ?? null,
    };

    if (!isPlainObject(infoPlist)) {
        findings.push({ invariant: 'info_plist', path: '.', reason: 'Info.plist must be a dictionary' });
        return { findings, advisories, inventory };
    }

    // ATS: secure defaults are required; broad bypasses are never acceptable.
    const ats = infoPlist.NSAppTransportSecurity;
    if (ats !== undefined) {
        if (!isPlainObject(ats)) {
            findings.push({ invariant: 'ats', path: 'NSAppTransportSecurity', reason: 'must be a dictionary' });
        } else {
            for (const key of BROAD_ATS_KEYS) {
                if (ats[key] === true) {
                    findings.push({
                        invariant: 'ats',
                        path: `NSAppTransportSecurity.${key}`,
                        reason: 'broad App Transport Security bypass must not ship in a release build',
                    });
                }
            }
            const exceptions = ats.NSExceptionDomains;
            if (isPlainObject(exceptions)) {
                for (const [domain, spec] of Object.entries(exceptions)) {
                    if (isPlainObject(spec) && spec.NSExceptionAllowsInsecureHTTPLoads === true) {
                        findings.push({
                            invariant: 'ats',
                            path: `NSExceptionDomains.${domain}`,
                            reason: 'insecure HTTP exception requires explicit reviewed justification',
                        });
                    }
                    if (isPlainObject(spec) && spec.NSExceptionMinimumTLSVersion) {
                        advisories.push({
                            invariant: 'ats',
                            path: `NSExceptionDomains.${domain}`,
                            reason: `TLS version weakened to ${spec.NSExceptionMinimumTLSVersion}; requires explicit review`,
                        });
                    }
                }
            }
        }
    }

    // Permission purpose strings: only approved keys, and never placeholders.
    const allowedUsage = new Set(policy.allowed_usage_description_keys ?? []);
    for (const key of Object.keys(infoPlist)) {
        if (!key.endsWith('UsageDescription')) continue;
        inventory.purposeStrings.push(key);
        if (!allowedUsage.has(key)) {
            findings.push({
                invariant: 'permission_surface',
                path: key,
                reason: 'permission purpose string is not in the approved capability contract',
            });
        }
        const value = infoPlist[key];
        if (typeof value !== 'string' || value.trim().length < 10 || /^(todo|tbd|placeholder|lorem)/i.test(value.trim())) {
            advisories.push({
                invariant: 'permission_surface',
                path: key,
                reason: 'purpose string looks like a placeholder and must describe the real purpose',
            });
        }
    }

    // URL schemes and query schemes.
    const allowedSchemes = new Set(policy.allowed_url_schemes ?? []);
    for (const entry of Array.isArray(infoPlist.CFBundleURLTypes) ? infoPlist.CFBundleURLTypes : []) {
        const schemes = Array.isArray(entry?.CFBundleURLSchemes) ? entry.CFBundleURLSchemes : [];
        for (const scheme of schemes) {
            inventory.urlSchemes.push(scheme);
            if (!allowedSchemes.has(scheme)) {
                findings.push({
                    invariant: 'url_surface',
                    path: scheme,
                    reason: 'URL scheme is not in the approved allowlist (stale debug or callback scheme?)',
                });
            }
        }
    }
    const allowedQuery = new Set(policy.allowed_query_schemes ?? []);
    for (const scheme of Array.isArray(infoPlist.LSApplicationQueriesSchemes) ? infoPlist.LSApplicationQueriesSchemes : []) {
        if (!allowedQuery.has(scheme)) {
            findings.push({
                invariant: 'url_surface',
                path: scheme,
                reason: 'queried URL scheme is not in the approved allowlist',
            });
        }
    }

    // Background modes, Bonjour, local network.
    const allowedBackground = new Set(policy.allowed_background_modes ?? []);
    for (const mode of inventory.backgroundModes) {
        if (!allowedBackground.has(mode)) {
            findings.push({
                invariant: 'capability_surface',
                path: mode,
                reason: 'background mode is not in the approved capability contract',
            });
        }
    }
    const allowedBonjour = new Set(policy.allowed_bonjour_services ?? []);
    for (const service of inventory.bonjourServices) {
        if (!allowedBonjour.has(service)) {
            findings.push({
                invariant: 'capability_surface',
                path: service,
                reason: 'Bonjour service is not in the approved capability contract',
            });
        }
    }

    // File sharing and document opening.
    for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) {
        if (infoPlist[key] === true && !(policy.allowed_document_exposure_keys ?? []).includes(key)) {
            findings.push({
                invariant: 'capability_surface',
                path: key,
                reason: 'document exposure to Files/iTunes is not part of the approved capability contract',
            });
        }
    }

    // Local network usage needs both the description and a reason.
    if (inventory.localNetwork !== null && !(policy.allowed_capability_keys ?? []).includes('NSLocalNetworkUsageDescription')) {
        findings.push({
            invariant: 'capability_surface',
            path: 'NSLocalNetworkUsageDescription',
            reason: 'local network usage is not part of the approved capability contract',
        });
    }

    // Capability keys the product should not declare at all.
    for (const key of policy.expected_absent_keys ?? []) {
        if (infoPlist[key] !== undefined) {
            findings.push({
                invariant: 'capability_surface',
                path: key,
                reason: 'capability is declared but the approved product contract expects it to be absent',
            });
        }
    }

    return { findings, advisories, inventory };
}

/**
 * D. Export-compliance evidence inventory. Reports only: this function records
 * what ships so a human can answer Apple's determination questions. It never
 * chooses the answer.
 */
export function evaluateExportCompliance(infoPlist, policy = {}) {
    const advisories = [];
    const key = policy.info_plist_key ?? 'ITSAppUsesNonExemptEncryption';
    const declared = infoPlist?.[key];

    advisories.push({
        invariant: 'export_compliance',
        path: key,
        reason: declared === undefined
            ? 'no export-compliance declaration in Info.plist; App Store Connect will require a determination for this app'
            : `declared value: ${JSON.stringify(declared)} (confirm it matches the crypto inventory below)`,
    });

    return {
        advisories,
        inventory: policy.crypto_components ?? [],
        disposition: policy.disposition ?? 'EXPORT_COMPLIANCE_OWNER_REVIEW_REQUIRED',
    };
}

/**
 * Convenience wrapper used by the release assertion. `plistLoader` lets callers
 * inject already-parsed values (tests) instead of shelling out to plutil.
 */
export function evaluateSubmissionMetadata({ privacyManifest, infoPlist, sources = {}, policy = {} }) {
    const manifestResult = evaluatePrivacyManifest(privacyManifest, policy.privacy_manifest ?? {});
    const apiAudit = auditRequiredReasonApis(sources, privacyManifest, policy.privacy_manifest?.required_reason_scan ?? {});
    const infoResult = evaluateInfoPlist(infoPlist, policy.info_plist ?? {});
    const exportResult = evaluateExportCompliance(infoPlist, policy.export_compliance ?? {});

    return {
        findings: [...manifestResult.findings, ...apiAudit.findings, ...infoResult.findings],
        advisories: [
            ...manifestResult.advisories,
            ...apiAudit.advisories,
            ...infoResult.advisories,
            ...exportResult.advisories,
        ],
        details: {
            privacyManifest: manifestResult.classification,
            requiredReasonApis: apiAudit.rows,
            infoPlist: infoResult.inventory,
            exportCompliance: { disposition: exportResult.disposition, crypto: exportResult.inventory },
        },
    };
}
