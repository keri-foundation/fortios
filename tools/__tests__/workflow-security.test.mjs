import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * GitHub Actions hardening contract.
 *
 * These assertions exist because workflow security is easy to regress silently:
 * a floating action tag, a widened token scope, a persisted checkout credential,
 * or an interpolated pull-request title all look harmless in a diff and are only
 * caught by review discipline. This is a targeted contract, not a YAML engine.
 *
 * Scope note: this file asserts *structure*. It does not decide whether a given
 * validation is correct; that belongs to the individual validators and their
 * tests.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

/**
 * Action refs that are known to float. Every other `uses:` must be pinned to a
 * full commit SHA. Resolving an entry here means deleting it — do not grow this
 * set to make a workflow pass.
 */
const UNVERIFIED_ACTION_PINS = new Set(['setup-python@v5']);

const WRITE_SCOPES = [
    'contents: write',
    'id-token: write',
    'pull-requests: write',
    'actions: write',
    'packages: write',
    'security-events: write',
    'deployments: write',
];

/**
 * Contexts an attacker can influence. They must never reach a shell command by
 * direct interpolation; pass them through `env:` and quote them instead.
 */
const UNTRUSTED_CONTEXTS = [
    'github.event.',
    'github.head_ref',
    'github.ref_name',
    'inputs.',
];

function workflowFiles() {
    return readdirSync(workflowsDir)
        .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
        .sort();
}

function readWorkflow(file) {
    return readFileSync(path.join(workflowsDir, file), 'utf8');
}

/** Lines that are not full-line YAML comments. */
function significantLines(text) {
    return text.split('\n').filter((line) => !/^\s*#/.test(line));
}

/**
 * Split a workflow into step-like blocks: a block starts at any list item and
 * runs until the next list item.
 */
function listBlocks(text) {
    const blocks = [];
    let current = null;

    for (const line of text.split('\n')) {
        if (/^\s*-\s+\S/.test(line)) {
            current = [line];
            blocks.push(current);
        } else if (current) {
            current.push(line);
        }
    }

    return blocks.map((block) => block.join('\n'));
}

/** Job name to job body, using top-level two-space indentation. */
function jobsOf(text) {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    expect(start, 'workflow must declare jobs').toBeGreaterThanOrEqual(0);

    const headers = [];
    for (let i = start + 1; i < lines.length; i += 1) {
        const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
        if (match) headers.push({ name: match[1], line: i });
    }

    return headers.map((header, index) => ({
        name: header.name,
        body: lines
            .slice(header.line, index + 1 < headers.length ? headers[index + 1].line : lines.length)
            .join('\n'),
    }));
}

/** Concatenated shell command text from every `run:` block. */
function runCommands(text) {
    const lines = text.split('\n');
    const commands = [];

    for (let i = 0; i < lines.length; i += 1) {
        const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
        if (!match) continue;

        const indent = match[1].length;
        const inline = match[2].trim();
        if (inline && !inline.startsWith('|') && !inline.startsWith('>')) {
            commands.push(inline);
            continue;
        }

        for (let j = i + 1; j < lines.length; j += 1) {
            const line = lines[j];
            if (line.trim() === '') continue;
            if (line.match(/^\s*/)[0].length <= indent) break;
            commands.push(line.trim());
        }
    }

    return commands.join('\n');
}

/** Every `uses:` reference with a `owner/action@ref` shape. */
function actionRefs(text) {
    const refs = [];
    for (const line of significantLines(text)) {
        const match = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
        if (!match) continue;
        const reference = match[1];
        const at = reference.lastIndexOf('@');
        if (at < 0) continue;
        refs.push({ reference, ref: reference.slice(at + 1) });
    }
    return refs;
}

function checkoutUsesRef(text) {
    return /uses:\s*actions\/checkout@\S+/.exec(text)?.[0] ?? null;
}

describe('workflow inventory', () => {
    it('covers every workflow in the repository', () => {
        const files = workflowFiles();

        expect(files).toEqual(['ios-security.yml', 'release-certification.yml', 'repo-hygiene.yml']);
    });
});

describe('token permissions', () => {
    it('declares explicit read-only permissions in every workflow', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);

            // An explicit permissions block makes every unlisted scope none.
            expect(workflow, `${file} must declare top-level permissions`).toMatch(/^permissions:/m);
            expect(workflow, `${file} must grant contents: read`).toMatch(/^permissions:\n {2}contents: read$/m);
        }
    });

    it('never grants a write scope to a validation workflow', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);
            for (const scope of WRITE_SCOPES) {
                expect(workflow, `${file} must not grant ${scope}`).not.toContain(scope);
            }
        }
    });

    it('avoids privileged triggers that run untrusted code', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);

            // pull_request_target and workflow_run both hand a privileged token
            // to code the PR author controls.
            expect(workflow, `${file} must not use pull_request_target`).not.toContain('pull_request_target');
            expect(workflow, `${file} must not use workflow_run`).not.toContain('workflow_run:');
        }
    });
});

describe('checkout and credentials', () => {
    it('does not persist checkout credentials in any job', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);
            const checkoutSteps = listBlocks(workflow).filter((block) => checkoutUsesRef(block) !== null);

            expect(checkoutSteps.length, `${file} must check out the repository`).toBeGreaterThan(0);
            for (const step of checkoutSteps) {
                expect(step, `${file}: checkout must disable persisted credentials`).toContain('persist-credentials: false');
            }
        }
    });
});

describe('action pinning', () => {
    it('pins every action to a full commit SHA', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);
            const refs = actionRefs(workflow);

            expect(refs.length, `${file} must use actions`).toBeGreaterThan(0);
            for (const { reference, ref } of refs) {
                const short = reference.split('@')[0].replace(/^actions\//, '');
                if (UNVERIFIED_ACTION_PINS.has(`${short}@${ref}`)) continue;
                expect(ref, `${file}: ${reference} must be pinned to a 40-character commit SHA`).toMatch(/^[0-9a-f]{40}$/);
            }
        }
    });

    it('keeps the floating-pin exception list exact', () => {
        const floating = new Set();

        for (const file of workflowFiles()) {
            for (const { reference, ref } of actionRefs(readWorkflow(file))) {
                if (/^[0-9a-f]{40}$/.test(ref)) continue;
                floating.add(`${reference.split('@')[0].replace(/^actions\//, '')}@${ref}`);
            }
        }

        // Growth means a new unpinned action; shrinkage means a pin was resolved
        // and this list must be updated in the same change.
        expect([...floating].sort()).toEqual([...UNVERIFIED_ACTION_PINS].sort());
    });
});

describe('shell injection surface', () => {
    it('never interpolates untrusted contexts into shell commands', () => {
        for (const file of workflowFiles()) {
            const commands = runCommands(readWorkflow(file));

            for (const context of UNTRUSTED_CONTEXTS) {
                expect(commands, `${file}: run block must not interpolate \${{ ${context}... }}`).not.toContain(`\${{ ${context}`);
            }
        }
    });

    it('passes dispatch inputs to shell through the environment', () => {
        const workflow = readWorkflow('release-certification.yml');

        expect(workflow).toContain('ARCHIVE_PATH_INPUT: ${{ inputs.archive_path }}');
        expect(runCommands(workflow)).toContain('"$ARCHIVE_PATH_INPUT"');
    });
});

describe('runner resource bounds', () => {
    it('bounds every job with a timeout', () => {
        for (const file of workflowFiles()) {
            const jobs = jobsOf(readWorkflow(file));

            expect(jobs.length, `${file} must declare jobs`).toBeGreaterThan(0);
            for (const job of jobs) {
                expect(job.body, `${file}: job ${job.name} must set timeout-minutes`).toMatch(/^ {4}timeout-minutes: \d+$/m);
            }
        }
    });
});

describe('required PR validators', () => {
    const prLane = () => readWorkflow('ios-security.yml');

    it('runs the deterministic validator set on every relevant change', () => {
        const commands = runCommands(prLane());

        expect(commands).toContain('make test-tools');
        expect(commands).toContain('make knip');
        expect(commands).toContain('make lint');
        expect(commands).toContain('make repo-hygiene');
        expect(commands).toContain('make payload-contract');
    });

    it('installs dependencies reproducibly', () => {
        for (const file of workflowFiles()) {
            const commands = runCommands(readWorkflow(file));

            expect(commands, `${file} must use npm ci where it installs`).not.toMatch(/npm install\b/);
        }
        expect(runCommands(prLane())).toContain('npm ci');
    });

    it('never regenerates a reviewed baseline', () => {
        for (const file of workflowFiles()) {
            const workflow = readWorkflow(file);

            // Baselines are inputs. Regenerating one in CI would silently accept
            // new violations instead of failing on them. Check the commands, not
            // the raw text: `.swiftlint-baseline.json` is a legitimate path
            // filter, and comments may name the local-only target.
            const commands = runCommands(workflow);
            expect(commands, `${file} must not regenerate the SwiftLint baseline`).not.toContain('lint-baseline');
            expect(commands, `${file} must not write a baseline`).not.toContain('write-baseline');

            // No workflow may enable baseline writing through a flag.
            const significant = significantLines(workflow).join('\n');
            expect(significant, `${file} must not pass --write-baseline`).not.toContain('--write-baseline');
        }
    });

    it('validates the archived payload in the PR lane, not the certification lane', () => {
        const commands = runCommands(prLane());

        expect(commands).toContain('node tools/assert-release-archive.mjs --archive build/KeriWallet.xcarchive');
        expect(commands).not.toContain('--release-certification');
    });

    it('keeps the tracked-tree boundary free of path filters', () => {
        const workflow = readWorkflow('repo-hygiene.yml');

        expect(workflow).toMatch(/^on:\n {2}pull_request:\n/m);
        expect(workflow, 'repo-hygiene must not be path filtered').not.toContain('paths:');
        expect(runCommands(workflow)).toContain('node tools/assert-repo-hygiene.mjs');
    });
});

describe('release certification lane', () => {
    const certification = () => readWorkflow('release-certification.yml');

    it('is manually dispatched and never automatic', () => {
        const workflow = certification();

        expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
        expect(workflow).not.toMatch(/^ {2}pull_request:/m);
        expect(workflow).not.toMatch(/^ {2}tags:/m);
    });

    it('enforces every invariant on the candidate archive', () => {
        const commands = runCommands(certification());

        expect(commands).toContain('--archive "$CANDIDATE_ARCHIVE"');
        expect(commands).toContain('--release-certification');
        expect(commands).toContain('--evidence "$EVIDENCE_PATH"');
        // No escape hatch: the gate must be able to fail the run.
        expect(certification()).not.toMatch(/^\s*continue-on-error:/m);
    });

    it('preserves evidence without publishing anything', () => {
        const workflow = certification();

        expect(workflow).toContain('name: release-certification-evidence');
        expect(workflow).toContain('path: ${{ env.EVIDENCE_PATH }}');
        expect(workflow).toContain('uses: actions/upload-artifact@26f96dfa697d77e81fd5907df203aa23a56210a8');
        expect(workflow).toContain('if: always()');
        // No signing, no publishing, no tag creation.
        expect(workflow).toContain('CODE_SIGNING_ALLOWED=NO');
        expect(workflow).not.toContain('gh release');
        expect(workflow).not.toContain('altool');
        expect(workflow).not.toContain('notarytool');
        expect(workflow).not.toContain('upload-app');
    });

    it('does not consume artifacts produced by another workflow', () => {
        for (const file of workflowFiles()) {
            // Cross-workflow artifact consumption is how an untrusted artifact
            // reaches a privileged job.
            expect(readWorkflow(file), `${file} must not download artifacts`).not.toContain('actions/download-artifact');
        }
    });
});
