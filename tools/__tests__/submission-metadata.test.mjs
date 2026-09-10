import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    auditRequiredReasonApis,
    evaluateExportCompliance,
    evaluateInfoPlist,
    evaluatePrivacyManifest,
    evaluateSubmissionMetadata,
} from '../submission-metadata.mjs';

/**
 * Submission-metadata regressions.
 *
 * Each case isolates one declaration boundary so an unrelated release failure
 * (for example the IOS-6 content gate) cannot make these pass or fail
 * incidentally. `findings` are hard failures; `advisories` are classifications
 * that require owner intent and must never silently gate a release.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shippedPolicy = JSON.parse(
    readFileSync(path.join(repoRoot, 'tools/release-sanitization-policy.json'), 'utf8'),
).submission_metadata;

const privacyPolicy = shippedPolicy.privacy_manifest;

/** The declarations the project currently ships. */
function currentManifest(overrides = {}) {
    return {
        NSPrivacyTracking: false,
        NSPrivacyCollectedDataTypes: [],
        NSPrivacyAccessedAPITypes: [
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
        ],
        ...overrides,
    };
}

/** An Info.plist with none of the capability-sensitive keys declared. */
function minimalInfoPlist(overrides = {}) {
    return {
        CFBundleDisplayName: 'KeriWallet',
        CFBundleShortVersionString: '1.0',
        MinimumOSVersion: '16.4',
        ...overrides,
    };
}

const sourcesWithObservedUsage = {
    'KeriWallet/PayloadSchemeHandler.swift': 'let attrs = try fileManager.attributesOfItem(atPath: p)',
    'KeriWallet/AppConfig.swift': 'UserDefaults.standard.string(forKey: "x")',
};

describe('privacy manifest structure', () => {
    it('accepts the current intended declarations', () => {
        const result = evaluatePrivacyManifest(currentManifest(), privacyPolicy);
        expect(result.findings).toEqual([]);
        expect(result.advisories).toEqual([]);
    });

    it('rejects a non-dictionary manifest', () => {
        const result = evaluatePrivacyManifest(['not', 'a', 'dict'], privacyPolicy);
        expect(result.findings.map((f) => f.reason)).toContain('privacy manifest root must be a dictionary');
    });

    it('rejects an unexpected top-level key', () => {
        const result = evaluatePrivacyManifest(currentManifest({ NSPrivacySomethingElse: true }), privacyPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacySomethingElse');
    });

    it('rejects a non-boolean tracking flag', () => {
        const result = evaluatePrivacyManifest(currentManifest({ NSPrivacyTracking: 'false' }), privacyPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacyTracking');
    });

    it('rejects tracking domains declared while tracking is off', () => {
        const result = evaluatePrivacyManifest(
            currentManifest({ NSPrivacyTrackingDomains: ['tracker.example.com'] }),
            privacyPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacyTrackingDomains');
    });

    it('rejects an unknown required-reason category', () => {
        const result = evaluatePrivacyManifest(currentManifest({
            NSPrivacyAccessedAPITypes: [
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryMadeUp', NSPrivacyAccessedAPITypeReasons: ['AAAA.1'] },
            ],
        }), privacyPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacyAccessedAPICategoryMadeUp');
    });

    it('rejects an empty reason array', () => {
        const result = evaluatePrivacyManifest(currentManifest({
            NSPrivacyAccessedAPITypes: [
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: [] },
            ],
        }), privacyPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacyAccessedAPICategoryFileTimestamp');
    });

    it('rejects an unapproved reason code', () => {
        const result = evaluatePrivacyManifest(currentManifest({
            NSPrivacyAccessedAPITypes: [
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['ZZZZ.9'] },
            ],
        }), privacyPolicy);
        expect(result.findings.some((f) => f.reason.includes('not an approved reason'))).toBe(true);
    });

    it('rejects a missing NSPrivacyAccessedAPITypes array', () => {
        const manifest = currentManifest();
        delete manifest.NSPrivacyAccessedAPITypes;
        const result = evaluatePrivacyManifest(manifest, privacyPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSPrivacyAccessedAPITypes');
    });
});

describe('required-reason API audit', () => {
    it('matches observed usage to declarations', () => {
        const audit = auditRequiredReasonApis(sourcesWithObservedUsage, currentManifest(), privacyPolicy.required_reason_scan);
        expect(audit.findings).toEqual([]);
        expect(audit.rows.filter((r) => r.status === 'MATCH')).toHaveLength(2);
    });

    it('flags observed usage that is not declared', () => {
        const audit = auditRequiredReasonApis(
            { 'KeriWallet/Some.swift': 'let t = ProcessInfo.processInfo.systemUptime' },
            currentManifest(),
            privacyPolicy.required_reason_scan,
        );
        expect(audit.findings.map((f) => f.path)).toContain('NSPrivacyAccessedAPICategorySystemBootTime');
    });

    it('reports a declaration with no observed use as stale, not as a failure', () => {
        const audit = auditRequiredReasonApis(
            { 'KeriWallet/PayloadSchemeHandler.swift': 'attributesOfItem' },
            currentManifest(),
            privacyPolicy.required_reason_scan,
        );
        expect(audit.findings).toEqual([]);
        expect(audit.advisories.map((a) => a.path)).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    });

    it('documents the live repository position: UserDefaults is declared but unused', async () => {
        const { readdir } = await import('node:fs/promises');
        const sources = {};
        for (const entry of await readdir(path.join(repoRoot, 'KeriWallet'), { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;
            sources[`KeriWallet/${entry.name}`] = readFileSync(path.join(repoRoot, 'KeriWallet', entry.name), 'utf8');
        }

        const audit = auditRequiredReasonApis(sources, currentManifest(), privacyPolicy.required_reason_scan);

        expect(audit.findings).toEqual([]);
        expect(audit.advisories.map((a) => a.path)).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults']);
    });
});

describe('Info.plist capability closure', () => {
    const infoPolicy = shippedPolicy.info_plist;

    it('accepts the current minimal declaration surface', () => {
        const result = evaluateInfoPlist(minimalInfoPlist(), infoPolicy);
        expect(result.findings).toEqual([]);
    });

    it('rejects a broad ATS bypass', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.invariant)).toContain('ats');
    });

    it('rejects ATS arbitrary loads in web content', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ NSAppTransportSecurity: { NSAllowsArbitraryLoadsInWebContent: true } }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('NSAppTransportSecurity.NSAllowsArbitraryLoadsInWebContent');
    });

    it('rejects an insecure exception domain', () => {
        const result = evaluateInfoPlist(minimalInfoPlist({
            NSAppTransportSecurity: {
                NSExceptionDomains: { 'example.com': { NSExceptionAllowsInsecureHTTPLoads: true } },
            },
        }), infoPolicy);
        expect(result.findings.map((f) => f.path)).toContain('NSExceptionDomains.example.com');
    });

    it('rejects an unexpected permission purpose string', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ NSCameraUsageDescription: 'Take a photo of your wallet QR code.' }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('NSCameraUsageDescription');
    });

    it('rejects an unexpected URL scheme', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['keriwallet-debug'] }] }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.invariant)).toContain('url_surface');
    });

    it('rejects an unexpected queried scheme', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ LSApplicationQueriesSchemes: ['facebook'] }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('facebook');
    });

    it('rejects an unexpected background mode', () => {
        const result = evaluateInfoPlist(minimalInfoPlist({ UIBackgroundModes: ['location'] }), infoPolicy);
        expect(result.findings.map((f) => f.path)).toContain('location');
    });

    it('rejects a Bonjour service', () => {
        const result = evaluateInfoPlist(minimalInfoPlist({ NSBonjourServices: ['_keri._tcp'] }), infoPolicy);
        expect(result.findings.map((f) => f.path)).toContain('_keri._tcp');
    });

    it('rejects local network usage', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ NSLocalNetworkUsageDescription: 'Find witnesses on your network.' }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('NSLocalNetworkUsageDescription');
    });

    it('rejects document exposure', () => {
        const result = evaluateInfoPlist(minimalInfoPlist({ UIFileSharingEnabled: true }), infoPolicy);
        expect(result.findings.map((f) => f.path)).toContain('UIFileSharingEnabled');
    });

    it('rejects a capability the product contract expects to be absent', () => {
        const result = evaluateInfoPlist(
            minimalInfoPlist({ NSAppTransportSecurity: { NSExceptionDomains: {} } }),
            infoPolicy,
        );
        expect(result.findings.map((f) => f.path)).toContain('NSAppTransportSecurity');
    });
});

describe('export compliance', () => {
    it('never declares a determination, only reports evidence', () => {
        const result = evaluateExportCompliance(minimalInfoPlist(), shippedPolicy.export_compliance);
        expect(result.disposition).toBe('EXPORT_COMPLIANCE_OWNER_REVIEW_REQUIRED');
        expect(result.inventory.length).toBeGreaterThan(0);
        expect(result.advisories[0].reason).toMatch(/no export-compliance declaration/);
    });

    it('reports the declaration when present', () => {
        const result = evaluateExportCompliance(
            minimalInfoPlist({ ITSAppUsesNonExemptEncryption: false }),
            shippedPolicy.export_compliance,
        );
        expect(result.advisories[0].reason).toMatch(/declared value/);
    });
});

describe('combined evaluation', () => {
    it('passes the intended declaration surface with matching usage', () => {
        const result = evaluateSubmissionMetadata({
            privacyManifest: currentManifest(),
            infoPlist: minimalInfoPlist(),
            sources: sourcesWithObservedUsage,
            policy: shippedPolicy,
        });

        expect(result.findings).toEqual([]);
    });

    it('reports manifest and plist failures together without masking either', () => {
        const result = evaluateSubmissionMetadata({
            privacyManifest: currentManifest({ NSPrivacyTracking: true }),
            infoPlist: minimalInfoPlist({ UIBackgroundModes: ['audio'] }),
            sources: sourcesWithObservedUsage,
            policy: shippedPolicy,
        });

        const invariants = result.findings.map((f) => f.invariant);
        expect(invariants).toContain('privacy_manifest');
        expect(invariants).toContain('capability_surface');
    });
});
