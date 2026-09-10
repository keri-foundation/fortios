import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * CI coverage contract for the iOS security workflow.
 *
 * The Xcode project and Swift sources were relocated to the repository root.
 * SwiftLint's configuration and the workflow trigger list both kept pointing at
 * the old layout, so linting silently matched zero files and edits to
 * security-relevant paths could bypass CI entirely.
 *
 * These assertions keep that from regressing: they fail if a first-party
 * source/config path stops being covered, or if the two trigger lists drift
 * apart.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ios-security.yml');
const swiftlintConfigPath = path.join(repoRoot, '.swiftlint.yml');
const makefilePath = path.join(repoRoot, 'Makefile');
const baselinePath = path.join(repoRoot, '.swiftlint-baseline.json');

/**
 * Paths that must be able to trigger the iOS security workflow. Paths Evan
 * identified as uncovered are included explicitly.
 */
const REQUIRED_TRIGGER_PATHS = [
    // Any workflow edit must re-run validation: these contract tests assert
    // workflow structure, so a change to a workflow file cannot bypass them.
    '.github/workflows/**',
    '.tool-versions',
    '.swiftlint.yml',
    '.swiftlint-baseline.json',
    '.gitignore',
    'Makefile',
    'bridge-contract.json',
    'knip.jsonc',
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'runtime-platform-config.json',
    'scripts/**',
    'tools/**',
    'KeriWallet/**',
    'KeriWalletTests/**',
    'KeriWalletUITests/**',
    'KeriWallet.xcodeproj/**',
    'generated/**',
    'Config/**',
];

/** Directories that never contain first-party Swift sources. */
const IGNORED_SWIFT_DIRS = new Set([
    '.git',
    'build',
    'node_modules',
    'WebPayload',
    'test-results',
    'xcodeproj',
    'DerivedData',
]);

/** Codegen output that is excluded from linting on purpose. */
const GENERATED_SWIFT_FILES = new Set(['KeriWallet/BridgeContract.swift']);

function readWorkflow() {
    return readFileSync(workflowPath, 'utf-8');
}

/**
 * Extract the quoted `paths:` entries for a trigger block, delimited by the
 * next top-level trigger key.
 */
function triggerPaths(workflow, startKey, endKey) {
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line.trimEnd() === startKey);
    const end = lines.findIndex((line, index) => index > start && line.trimEnd() === endKey);
    expect(start, `${startKey} block must exist`).toBeGreaterThanOrEqual(0);
    expect(end, `${endKey} block must follow ${startKey}`).toBeGreaterThan(start);

    return lines
        .slice(start + 1, end)
        .map((line) => /^\s+-\s+'([^']+)'\s*$/.exec(line))
        .filter(Boolean)
        .map((match) => match[1]);
}

function listSwiftSources() {
    const found = [];

    function walk(dir, prefix) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (IGNORED_SWIFT_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel);
            } else if (entry.isFile() && entry.name.endsWith('.swift')) {
                found.push(rel);
            }
        }
    }

    walk(repoRoot, '');
    return found.sort();
}

/** Read a `key:` list from .swiftlint.yml without a YAML dependency. */
function swiftlintList(key) {
    const lines = readFileSync(swiftlintConfigPath, 'utf-8').split('\n');
    const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
    if (start < 0) return [];

    const values = [];
    for (const line of lines.slice(start + 1)) {
        const match = /^\s+-\s+(.+?)\s*$/.exec(line);
        if (!match) break;
        values.push(match[1]);
    }
    return values;
}

describe('iOS security workflow trigger coverage', () => {
    it('triggers on every first-party source, config, and security path', () => {
        const workflow = readWorkflow();
        const pullRequestPaths = triggerPaths(workflow, '  pull_request:', '  push:');
        const pushPaths = triggerPaths(workflow, '  push:', '  workflow_dispatch:');

        for (const required of REQUIRED_TRIGGER_PATHS) {
            expect(pullRequestPaths, `pull_request must trigger on ${required}`).toContain(required);
            expect(pushPaths, `push must trigger on ${required}`).toContain(required);
        }
    });

    it('keeps the pull_request and push trigger lists identical', () => {
        const workflow = readWorkflow();
        const pullRequestPaths = triggerPaths(workflow, '  pull_request:', '  push:');
        const pushPaths = triggerPaths(workflow, '  push:', '  workflow_dispatch:');

        // Drift between the two lists is how "updated one and forgot the other"
        // regressions appear.
        expect(pushPaths).toEqual(pullRequestPaths);
    });

    it('does not reference the retired xcodeproj path', () => {
        const workflow = readWorkflow();
        expect(workflow).not.toContain("'xcodeproj/**'");
        expect(existsSync(path.join(repoRoot, 'KeriWallet.xcodeproj', 'project.pbxproj'))).toBe(true);
    });

    it('triggers on the release policy so a policy edit cannot skip validation', () => {
        const workflow = readWorkflow();
        const pullRequestPaths = triggerPaths(workflow, '  pull_request:', '  push:');

        // The sanitization policy lives in tools/ and drives every release
        // assertion; tools/** coverage is what keeps a policy edit reviewable.
        expect(pullRequestPaths).toContain('tools/**');
        expect(existsSync(path.join(repoRoot, 'tools', 'release-sanitization-policy.json'))).toBe(true);
    });
});

describe('SwiftLint coverage and enforcement', () => {
    it('keeps every SwiftLint included path real and covers all first-party Swift files', () => {
        const included = swiftlintList('included');
        const excluded = swiftlintList('excluded');

        expect(included.length).toBeGreaterThan(0);

        for (const entry of included) {
            expect(existsSync(path.join(repoRoot, entry)), `${entry} must exist`).toBe(true);
        }

        const uncovered = listSwiftSources().filter((rel) => {
            if (excluded.includes(rel)) return false;
            if (GENERATED_SWIFT_FILES.has(rel)) return false;
            return !included.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
        });

        expect(uncovered).toEqual([]);
    });

    it('excludes only generated codegen output', () => {
        expect(swiftlintList('excluded')).toEqual([...GENERATED_SWIFT_FILES]);
    });

    it('runs SwiftLint from one canonical entrypoint shared by local and CI', () => {
        const makefile = readFileSync(makefilePath, 'utf-8');
        const workflow = readWorkflow();

        expect(makefile).toMatch(/^lint:.*$/m);
        expect(makefile).toContain('swiftlint lint --config .swiftlint.yml --strict --baseline .swiftlint-baseline.json');
        expect(makefile).toMatch(/^lint-baseline:.*$/m);

        // The workflow must call the same entrypoint rather than a divergent
        // command line.
        expect(workflow).toContain('run: make lint');
        expect(workflow).not.toMatch(/run: swiftlint lint/);
    });

    it('keeps a valid frozen violation baseline', () => {
        const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
        expect(Array.isArray(baseline)).toBe(true);
        expect(baseline.length).toBeGreaterThan(0);
        for (const entry of baseline) {
            expect(typeof entry.violation.ruleIdentifier).toBe('string');
            expect(typeof entry.violation.location.file).toBe('string');
        }
    });

    it('records baseline paths relative to the checkout', () => {
        const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

        // A baseline entry only suppresses a violation when its path resolves to
        // the file being linted. Absolute entries bake in the machine that wrote
        // them, so a baseline generated inside a temporary worktree matches
        // nothing in CI and every approved violation leaks at once. That is a
        // silent, total failure of the freeze, so the path form is asserted here.
        for (const entry of baseline) {
            expect(
                entry.violation.location.file,
                'baseline paths must be checkout-relative',
            ).not.toMatch(/^\//);
        }
    });

    it('lints every first-party Swift file found in the repository', () => {
        const included = swiftlintList('included');
        const sources = listSwiftSources();
        const covered = sources.filter((rel) =>
            included.some((dir) => rel === dir || rel.startsWith(`${dir}/`)),
        );

        // Every discovered Swift file lives under a linted directory; the only
        // intentionally unlinted file is the excluded codegen output.
        expect(covered).toEqual(sources);
        expect(covered.length).toBeGreaterThan(0);
    });
});
