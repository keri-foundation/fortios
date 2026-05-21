import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');
const expectedContract = {
    producer: 'fortweb-shared',
    payloadProfile: 'product-shell',
    entryDocument: 'fortweb/app/index.html',
    entryScript: 'fortweb/app/app/main.js',
    payloadSource: 'PAYLOAD_SOURCE=fortweb',
};

function parseArgs(argv) {
    const options = {
        root: defaultRoot,
        payloadDir: null,
        target: 'ios-webpayload',
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--root') {
            options.root = path.resolve(argv[index + 1]);
            index += 1;
            continue;
        }
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
        options.payloadDir = path.join(options.root, 'WebPayload');
    }

    return options;
}

function normalizeRelativePath(root, targetPath) {
    return path.relative(root, targetPath).replaceAll('\\', '/');
}

function violation(file, reason, expected) {
    return { file, reason, expected };
}

function printViolation(item) {
    console.log('[webpayload-drift] violation');
    console.log(`  file: ${item.file}`);
    console.log(`  reason: ${item.reason}`);
    console.log(`  expected: ${item.expected}`);
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

async function hashPayloadTree(payloadDir) {
    const files = await listFilesRec(payloadDir);
    files.sort((left, right) => left.localeCompare(right));

    const hash = createHash('sha256');
    for (const absPath of files) {
        const relPath = normalizeRelativePath(payloadDir, absPath);
        if (relPath === 'build-manifest.json') {
            continue;
        }

        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) {
            continue;
        }

        hash.update(relPath);
        hash.update('\n');
        hash.update(await readFile(absPath));
        hash.update('\n');
    }

    return hash.digest('hex');
}

function extractPinnedRef(buildCommand) {
    const match = buildCommand.match(/(?:^|\s)FORTWEB_REF=([0-9a-f]{40})(?:\s|$)/i);
    return match?.[1] ?? null;
}

async function readManifest(manifestPath) {
    let manifestText;
    try {
        manifestText = await readFile(manifestPath, 'utf8');
    } catch {
        return {
            violations: [
                violation(
                    'build-manifest.json',
                    'missing staged WebPayload build manifest',
                    'WebPayload must contain a readable build-manifest.json with recorded FortWeb provenance.'
                ),
            ],
            manifest: null,
        };
    }

    try {
        return { violations: [], manifest: JSON.parse(manifestText) };
    } catch {
        return {
            violations: [
                violation(
                    'build-manifest.json',
                    'malformed JSON in staged WebPayload manifest',
                    'WebPayload build-manifest.json must be valid JSON before validation can trust its provenance.'
                ),
            ],
            manifest: null,
        };
    }
}

async function validatePayload(manifest, payloadDir, root, target) {
    const payloadRelPath = normalizeRelativePath(root, payloadDir);
    const violations = [];
    const expected = 'Fort-ios WebPayload must match the recorded FortWeb product-shell provenance without restaging.';

    if (manifest.producer !== expectedContract.producer) {
        violations.push(
            violation(
                'build-manifest.json',
                `producer drift: expected ${expectedContract.producer}, found ${manifest.producer ?? 'missing'}`,
                expected
            )
        );
    }

    if (manifest.payload_profile !== expectedContract.payloadProfile) {
        violations.push(
            violation(
                'build-manifest.json',
                `payload profile drift: expected ${expectedContract.payloadProfile}, found ${manifest.payload_profile ?? 'missing'}`,
                expected
            )
        );
    }

    if (manifest.entry_document !== expectedContract.entryDocument) {
        violations.push(
            violation(
                'build-manifest.json',
                `entry document drift: expected ${expectedContract.entryDocument}, found ${manifest.entry_document ?? 'missing'}`,
                expected
            )
        );
    }

    if (manifest.entry_script !== expectedContract.entryScript) {
        violations.push(
            violation(
                'build-manifest.json',
                `entry script drift: expected ${expectedContract.entryScript}, found ${manifest.entry_script ?? 'missing'}`,
                expected
            )
        );
    }

    if (typeof manifest.build_command !== 'string' || !manifest.build_command.includes(expectedContract.payloadSource)) {
        violations.push(
            violation(
                'build-manifest.json',
                'build command no longer records PAYLOAD_SOURCE=fortweb provenance',
                expected
            )
        );
    }

    if (!Array.isArray(manifest.sync_targets)) {
        violations.push(
            violation(
                'build-manifest.json',
                'sync_targets must be an array describing the staged WebPayload destination',
                expected
            )
        );
    } else {
        const syncTarget = manifest.sync_targets.find((entry) => entry?.id === target);
        if (!syncTarget) {
            violations.push(
                violation(
                    'build-manifest.json',
                    `manifest missing sync target ${target}`,
                    expected
                )
            );
        } else if (syncTarget.path !== payloadRelPath) {
            violations.push(
                violation(
                    'build-manifest.json',
                    `sync target path drift: expected ${payloadRelPath}, found ${syncTarget.path ?? 'missing'}`,
                    expected
                )
            );
        }
    }

    const requiredFiles = [
        'index.html',
        manifest.entry_document,
        manifest.entry_script,
    ].filter(Boolean);

    for (const relPath of requiredFiles) {
        try {
            await readFile(path.join(payloadDir, relPath));
        } catch {
            violations.push(
                violation(
                    relPath,
                    'staged WebPayload is missing a manifest-declared entry file',
                    expected
                )
            );
        }
    }

    if (typeof manifest.dist_tree_sha256 !== 'string' || !manifest.dist_tree_sha256) {
        violations.push(
            violation(
                'build-manifest.json',
                'dist_tree_sha256 is missing; cannot detect accidental staged payload drift',
                expected
            )
        );
    } else {
        const actualTreeHash = await hashPayloadTree(payloadDir);
        if (actualTreeHash !== manifest.dist_tree_sha256) {
            violations.push(
                violation(
                    'build-manifest.json',
                    `staged WebPayload tree hash drift: expected ${manifest.dist_tree_sha256}, found ${actualTreeHash}`,
                    expected
                )
            );
        }
    }

    const pinnedRef = typeof manifest.build_command === 'string' ? extractPinnedRef(manifest.build_command) : null;
    if (pinnedRef && manifest.git_sha !== pinnedRef) {
        violations.push(
            violation(
                'build-manifest.json',
                `git SHA drift: build command pins ${pinnedRef}, manifest records ${manifest.git_sha ?? 'missing'}`,
                expected
            )
        );
    }

    return violations;
}

async function main() {
    const { root, payloadDir, target } = parseArgs(process.argv.slice(2));
    const manifestPath = path.join(payloadDir, 'build-manifest.json');
    const { manifest, violations: manifestReadViolations } = await readManifest(manifestPath);

    console.log(`[webpayload-drift] root: ${root}`);
    console.log(`[webpayload-drift] payload directory: ${payloadDir}`);
    console.log(`[webpayload-drift] target: ${target}`);

    if (!manifest) {
        for (const item of manifestReadViolations) {
            printViolation(item);
        }
        console.log('[webpayload-drift] result: FAIL');
        process.exitCode = 1;
        return;
    }

    console.log(`[webpayload-drift] producer: ${manifest.producer ?? 'missing'}`);
    console.log(`[webpayload-drift] payload profile: ${manifest.payload_profile ?? 'missing'}`);
    console.log(`[webpayload-drift] git sha: ${manifest.git_sha ?? 'missing'}`);
    console.log(`[webpayload-drift] dist tree sha256: ${manifest.dist_tree_sha256 ?? 'missing'}`);

    const violations = await validatePayload(manifest, payloadDir, root, target);

    if (violations.length === 0) {
        console.log('[webpayload-drift] result: PASS');
        return;
    }

    for (const item of violations) {
        printViolation(item);
    }

    console.log('[webpayload-drift] result: FAIL');
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[webpayload-drift] result: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});