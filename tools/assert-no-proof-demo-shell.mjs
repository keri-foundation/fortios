import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');

const TEXT_FILE_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.sh',
    '.swift',
    '.ts',
    '.tsx',
    '.txt',
    '.xml',
    '.yml',
    '.yaml',
]);

const ACTIVE_SCAN_PATHS = [
    '.github',
    'KeriWallet',
    'KeriWalletTests',
    'playwright',
    'src',
    'tools',
    'xcodeproj',
    'Makefile',
    'README.md',
    'build-payload.sh',
    'package.json',
    'package-lock.json',
    'sync-payload.sh',
];

const EXCEPTION_PATH_PATTERNS = [
    /^tools\/assert-no-proof-demo-shell\.mjs$/,
    /^tools\/validate-mobile-payload\.mjs$/,
    /^tools\/__tests__\/payload-tooling\.test\.mjs$/,
    /^KeriWalletTests\/PayloadSchemeHandlerTests\.swift$/,
];

const BANNED_RULES = [
    ['Profile ID', 'legacy proof-shell UI label is banned from active upstream posture'],
    ['profile-id', 'legacy proof-shell DOM ids are banned from active upstream posture'],
    ['Display name', 'legacy proof-shell placeholder copy is banned from active upstream posture'],
    ['Optional note', 'legacy proof-shell placeholder copy is banned from active upstream posture'],
    ['No record loaded', 'legacy proof-shell record state is banned from active upstream posture'],
    ['Seed Test Data', 'legacy local data-seeding controls are banned from active upstream posture'],
    ['List Identifiers', 'legacy local identifier enumeration controls are banned from active upstream posture'],
    ['Pyodide boot failed', 'legacy removed-shell failure copy is banned from active upstream posture'],
    ['Importing a module script failed', 'legacy removed-shell loader failure copy is banned from active upstream posture'],
    ['PAYLOAD_SOURCE=fort-ios', 'the wrapper must not advertise or stage a fort-ios payload lane'],
    ['sync-fortios', 'the wrapper must not expose a fort-ios sync lane'],
    ['fort-ios-local', 'the wrapper must not identify live payloads as fort-ios-local'],
    ['proof-shell', 'the wrapper must not identify live payloads as proof-shell'],
    ['proof shell', 'legacy proof-shell wording is banned from active upstream posture'],
    ['proof surface', 'legacy proof-surface wording is banned from active upstream posture'],
    ['demo shell', 'demo-shell wording is banned from active upstream posture'],
    ['fortios-demo', 'demo payload identifiers are banned from active upstream posture'],
    ['demo payload', 'demo payload wording is banned from active upstream posture'],
    ['demo app', 'demo app wording is banned from active upstream posture'],
];

const EXPECTED_POSTURE = 'Fort-ios must stage and serve the FortWeb product-shell payload.';

function parseArgs(argv) {
    const options = { root: defaultRoot };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--root') {
            options.root = path.resolve(argv[index + 1]);
            index += 1;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    return options;
}

async function listFilesRec(absPath) {
    const entries = await readdir(absPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const childPath = path.join(absPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFilesRec(childPath)));
            continue;
        }
        if (entry.isFile()) {
            files.push(childPath);
        }
    }

    return files;
}

function isAllowedException(relPath) {
    return EXCEPTION_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isTextFile(relPath) {
    const baseName = path.basename(relPath);
    return baseName === 'Makefile' || TEXT_FILE_EXTENSIONS.has(path.extname(relPath));
}

async function collectActiveFiles(root) {
    const files = [];

    for (const relPath of ACTIVE_SCAN_PATHS) {
        const absPath = path.join(root, relPath);
        try {
            const childFiles = await listFilesRec(absPath);
            files.push(...childFiles);
        } catch {
            try {
                const content = await readFile(absPath);
                if (content.length >= 0) {
                    files.push(absPath);
                }
            } catch {
                // Ignore missing optional paths such as .github/ on upstream/main.
            }
        }
    }

    return files;
}

function printViolation(violation) {
    console.log('[repo-guard] violation');
    console.log(`  file: ${violation.file}`);
    console.log(`  string: ${JSON.stringify(violation.string)}`);
    console.log(`  reason: ${violation.reason}`);
    console.log(`  expected: ${violation.expected}`);
}

async function main() {
    const { root } = parseArgs(process.argv.slice(2));
    const activeFiles = await collectActiveFiles(root);
    const violations = [];

    for (const absPath of activeFiles) {
        const relPath = path.relative(root, absPath).replaceAll('\\', '/');
        if (!isTextFile(relPath) || isAllowedException(relPath)) {
            continue;
        }

        const content = await readFile(absPath, 'utf8');
        for (const [marker, reason] of BANNED_RULES) {
            if (content.includes(marker)) {
                violations.push({
                    file: relPath,
                    string: marker,
                    reason,
                    expected: EXPECTED_POSTURE,
                });
            }
        }
    }

    console.log(`[repo-guard] root: ${root}`);
    console.log(`[repo-guard] scanned files: ${activeFiles.length}`);

    if (violations.length === 0) {
        console.log('[repo-guard] result: PASS');
        return;
    }

    for (const violation of violations) {
        printViolation(violation);
    }

    console.log('[repo-guard] result: FAIL');
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[repo-guard] result: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
