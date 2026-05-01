import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const TEXT_FILE_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt']);
const REQUIRED_MANIFEST_FIELDS = [
    'producer',
    'payload_profile',
    'entry_document',
    'entry_script',
    'build_command',
    'pyodide_worker_mode',
    'pyodide_asset_path',
    'pyodide_asset_mode',
    'sync_targets',
    'source_git_branch',
    'source_git_status',
];
const IOS_WRAPPER_CONTRACT = {
    producer: 'fortweb-shared',
    payloadProfile: 'product-shell',
    entryDocument: 'fortweb/app/index.html',
    entryScript: 'fortweb/app/app/main.js',
    wrapperIndexRedirect: './fortweb/app/index.html',
    expectedPosture: 'Fort-ios must stage and serve the FortWeb product-shell payload.',
};
const BANNED_MARKERS = [
    {
        marker: 'Profile ID',
        reason: 'legacy proof-shell field labels must not ship in the wrapper payload',
    },
    {
        marker: 'profile-id',
        reason: 'legacy proof-shell field ids must not ship in the wrapper payload',
    },
    {
        marker: 'Display name',
        reason: 'legacy proof-shell placeholder copy must not ship in the wrapper payload',
    },
    {
        marker: 'Optional note',
        reason: 'legacy proof-shell placeholder copy must not ship in the wrapper payload',
    },
    {
        marker: 'No record loaded',
        reason: 'legacy proof-shell record state must not ship in the wrapper payload',
    },
    {
        marker: 'Seed Test Data',
        reason: 'legacy local validation controls must not ship in the wrapper payload',
    },
    {
        marker: 'List Identifiers',
        reason: 'legacy local validation controls must not ship in the wrapper payload',
    },
    {
        marker: 'Pyodide boot failed',
        reason: 'legacy failure copy from the removed proof shell must not ship in the wrapper payload',
    },
    {
        marker: 'Importing a module script failed',
        reason: 'legacy module-loader failure copy from the removed proof shell must not ship in the wrapper payload',
    },
    {
        marker: 'fort-ios-local',
        reason: 'the wrapper must not identify the payload as a local Fort-ios producer',
    },
    {
        marker: 'proof-shell',
        reason: 'the wrapper must not identify the payload as a proof-shell profile',
    },
];

function parseArgs(argv) {
    const options = {
        payloadDir: null,
        target: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--payload-dir') {
            options.payloadDir = path.resolve(argv[index + 1]);
            index += 1;
            continue;
        }
        if (arg === '--target') {
            options.target = argv[index + 1];
            index += 1;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    if (!options.payloadDir) {
        throw new Error('--payload-dir is required');
    }

    return options;
}

async function listFilesRec(absDir) {
    const entries = await readdir(absDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absPath = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFilesRec(absPath)));
            continue;
        }
        if (entry.isFile()) {
            files.push(absPath);
        }
    }

    return files;
}

function manifestViolation(field, detail) {
    return {
        file: 'build-manifest.json',
        string: field,
        reason: detail,
        expected: IOS_WRAPPER_CONTRACT.expectedPosture,
    };
}

function validateManifest(manifest, target) {
    const violations = [];

    for (const field of REQUIRED_MANIFEST_FIELDS) {
        if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
            violations.push(manifestViolation(field, `missing manifest field: ${field}`));
        }
    }

    if (!Array.isArray(manifest.sync_targets)) {
        violations.push(manifestViolation('sync_targets', 'manifest field sync_targets must be an array'));
        return violations;
    }

    if (target && !manifest.sync_targets.some((entry) => entry?.id === target)) {
        violations.push(manifestViolation(target, `manifest does not declare sync target: ${target}`));
    }

    if (target === 'ios-webpayload') {
        if (manifest.producer !== IOS_WRAPPER_CONTRACT.producer) {
            violations.push(
                manifestViolation(
                    String(manifest.producer ?? 'missing'),
                    `ios-webpayload requires producer ${IOS_WRAPPER_CONTRACT.producer}`
                )
            );
        }

        if (manifest.payload_profile !== IOS_WRAPPER_CONTRACT.payloadProfile) {
            violations.push(
                manifestViolation(
                    String(manifest.payload_profile ?? 'missing'),
                    `ios-webpayload requires payload profile ${IOS_WRAPPER_CONTRACT.payloadProfile}`
                )
            );
        }

        if (manifest.entry_document !== IOS_WRAPPER_CONTRACT.entryDocument) {
            violations.push(
                manifestViolation(
                    String(manifest.entry_document ?? 'missing'),
                    `ios-webpayload requires entry document ${IOS_WRAPPER_CONTRACT.entryDocument}`
                )
            );
        }

        if (manifest.entry_script !== IOS_WRAPPER_CONTRACT.entryScript) {
            violations.push(
                manifestViolation(
                    String(manifest.entry_script ?? 'missing'),
                    `ios-webpayload requires entry script ${IOS_WRAPPER_CONTRACT.entryScript}`
                )
            );
        }
    }

    return violations;
}

async function validateWrapperLayout(payloadDir, target) {
    const violations = [];

    if (target !== 'ios-webpayload') {
        return violations;
    }

    let wrapperIndex;
    try {
        wrapperIndex = await readFile(path.join(payloadDir, 'index.html'), 'utf8');
    } catch {
        violations.push({
            file: 'index.html',
            string: 'index.html',
            reason: 'ios-webpayload missing wrapper root document',
            expected: IOS_WRAPPER_CONTRACT.expectedPosture,
        });
        return violations;
    }

    if (!wrapperIndex.includes(IOS_WRAPPER_CONTRACT.wrapperIndexRedirect)) {
        violations.push({
            file: 'index.html',
            string: IOS_WRAPPER_CONTRACT.wrapperIndexRedirect,
            reason: 'wrapper root must redirect to the FortWeb entry document',
            expected: IOS_WRAPPER_CONTRACT.expectedPosture,
        });
    }

    try {
        await readFile(path.join(payloadDir, IOS_WRAPPER_CONTRACT.entryDocument), 'utf8');
    } catch {
        violations.push({
            file: IOS_WRAPPER_CONTRACT.entryDocument,
            string: IOS_WRAPPER_CONTRACT.entryDocument,
            reason: 'staged wrapper payload is missing the FortWeb entry document',
            expected: IOS_WRAPPER_CONTRACT.expectedPosture,
        });
    }

    return violations;
}

async function scanForBannedMarkers(payloadDir) {
    const matches = [];
    const files = await listFilesRec(payloadDir);

    for (const absPath of files) {
        if (!TEXT_FILE_EXTENSIONS.has(path.extname(absPath))) {
            continue;
        }

        const relPath = path.relative(payloadDir, absPath).replaceAll('\\', '/');
        const content = await readFile(absPath, 'utf8');

        for (const marker of BANNED_MARKERS) {
            if (content.includes(marker.marker)) {
                matches.push({
                    file: relPath,
                    string: marker.marker,
                    reason: marker.reason,
                    expected: IOS_WRAPPER_CONTRACT.expectedPosture,
                });
            }
        }
    }

    return matches;
}

function printViolation(violation) {
    console.log('[payload-check] violation');
    console.log(`  file: ${violation.file}`);
    console.log(`  string: ${JSON.stringify(violation.string)}`);
    console.log(`  reason: ${violation.reason}`);
    console.log(`  expected: ${violation.expected}`);
}

async function main() {
    const { payloadDir, target } = parseArgs(process.argv.slice(2));
    const manifestPath = path.join(payloadDir, 'build-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    const manifestViolations = validateManifest(manifest, target);
    const layoutViolations = await validateWrapperLayout(payloadDir, target);
    const markerViolations = await scanForBannedMarkers(payloadDir);

    console.log(`[payload-check] payload directory: ${payloadDir}`);
    console.log(`[payload-check] target: ${target ?? 'unspecified'}`);
    console.log(`[payload-check] producer: ${manifest.producer ?? 'missing'}`);
    console.log(`[payload-check] payload profile: ${manifest.payload_profile ?? 'missing'}`);
    console.log(`[payload-check] entry document: ${manifest.entry_document ?? 'missing'}`);
    console.log(`[payload-check] entry script: ${manifest.entry_script ?? 'missing'}`);

    const violations = [...manifestViolations, ...layoutViolations, ...markerViolations];
    if (violations.length === 0) {
        console.log('[payload-check] result: PASS');
        return;
    }

    for (const violation of violations) {
        printViolation(violation);
    }

    console.log('[payload-check] result: FAIL');
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[payload-check] result: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
