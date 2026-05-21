import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');

const FILE_CANDIDATES = {
    appConfig: [
        'KeriWallet/AppConfig.swift',
        'xcodeproj/KeriWallet/KeriWallet/AppConfig.swift',
    ],
    webContainer: [
        'KeriWallet/WebContainerViewController.swift',
        'xcodeproj/KeriWallet/KeriWallet/WebContainerViewController.swift',
    ],
    loopbackServer: ['xcodeproj/KeriWallet/KeriWallet/LocalLoopbackPayloadServer.swift'],
};

const BROAD_BIND_PATTERNS = [
    { pattern: /"0\.0\.0\.0"/, message: 'loopback host must not bind 0.0.0.0' },
    { pattern: /"localhost"/i, message: 'loopback host must use 127.0.0.1 instead of localhost' },
    { pattern: /"::"/, message: 'loopback host must not bind the IPv6 any-interface literal ::' },
    { pattern: /"\*"/, message: 'loopback host must not use the wildcard host literal *' },
    { pattern: /host:\s*NWEndpoint\.Host\(\s*""\s*\)/, message: 'loopback host must not be empty' },
];

const SENSITIVE_LOG_PATTERNS = [
    { pattern: /requestBody/i, message: 'loopback logging must not include request bodies' },
    { pattern: /responseBody/i, message: 'loopback logging must not include response bodies' },
    { pattern: /httpBody/i, message: 'loopback logging must not include HTTP bodies' },
    { pattern: /allHTTPHeaderFields/i, message: 'loopback logging must not include HTTP header dumps' },
    { pattern: /logHeaders/i, message: 'loopback logging must not include header dump helpers' },
    { pattern: /logBody/i, message: 'loopback logging must not include body dump helpers' },
    { pattern: /servedFileContents/i, message: 'loopback logging must not include served file contents' },
    { pattern: /passcode/i, message: 'loopback logging must not include passcodes' },
    { pattern: /password/i, message: 'loopback logging must not include passwords' },
    { pattern: /privateKey/i, message: 'loopback logging must not include private keys' },
    { pattern: /vaultContents/i, message: 'loopback logging must not include vault contents' },
    { pattern: /secret/i, message: 'loopback logging must not include secrets' },
    { pattern: /\bseed\b/i, message: 'loopback logging must not include seed material' },
];

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

async function maybeRead(root, relPath) {
    const absPath = path.join(root, relPath);
    try {
        const content = await readFile(absPath, 'utf8');
        return { absPath, relPath, content };
    } catch {
        return null;
    }
}

async function readFirstExisting(root, relPaths) {
    for (const relPath of relPaths) {
        const file = await maybeRead(root, relPath);
        if (file) {
            return file;
        }
    }
    return null;
}

function violation(file, reason, expected) {
    return { file, reason, expected };
}

function extractLoopbackEnum(appConfigContent) {
    const match = appConfigContent.match(/enum Loopback \{([\s\S]*?)\n\s*}\n\n\s*\/\//);
    return match?.[1] ?? null;
}

function validateLoopbackGating(appConfigFile, webContainerFile) {
    const violations = [];
    const loopbackEnum = extractLoopbackEnum(appConfigFile.content);
    const expected = 'Loopback is diagnostic-only scaffolding and must remain debug-gated, off by default, and loopback-only.';

    if (!loopbackEnum) {
        violations.push(
            violation(
                appConfigFile.relPath,
                'missing AppConfig.Loopback enum while loopback server exists',
                expected
            )
        );
        return violations;
    }

    const hostMatch = loopbackEnum.match(/static let host = "([^"]+)"/);
    if (!hostMatch) {
        violations.push(
            violation(appConfigFile.relPath, 'missing AppConfig.Loopback.host definition', expected)
        );
    } else if (hostMatch[1] !== '127.0.0.1') {
        violations.push(
            violation(
                appConfigFile.relPath,
                `loopback host must be exactly 127.0.0.1, found ${hostMatch[1]}`,
                expected
            )
        );
    }

    const isEnabledIndex = loopbackEnum.indexOf('static var isEnabled: Bool {');
    if (isEnabledIndex === -1) {
        violations.push(
            violation(appConfigFile.relPath, 'missing AppConfig.Loopback.isEnabled gate', expected)
        );
        return violations;
    }

    const isEnabledBody = loopbackEnum.slice(isEnabledIndex);
    if (!/#if DEBUG/.test(isEnabledBody)) {
        violations.push(
            violation(appConfigFile.relPath, 'loopback enablement must be wrapped in #if DEBUG', expected)
        );
    }
    const elseBlock = isEnabledBody.match(/#else([\s\S]*?)#endif/);
    if (!elseBlock || !/return false/.test(elseBlock[1])) {
        violations.push(
            violation(
                appConfigFile.relPath,
                'non-debug loopback path must explicitly return false',
                expected
            )
        );
    }
    if (!/#endif/.test(isEnabledBody)) {
        violations.push(
            violation(appConfigFile.relPath, 'loopback enablement must close with #endif', expected)
        );
    }

    if (!webContainerFile.content.includes('if AppConfig.Loopback.isEnabled')) {
        violations.push(
            violation(
                webContainerFile.relPath,
                'web container must route loopback activation through AppConfig.Loopback.isEnabled',
                expected
            )
        );
    }

    return violations;
}

function validateBindHosts(appConfigFile, loopbackServerFile) {
    const expected = 'Loopback is diagnostic-only scaffolding and must bind only to 127.0.0.1.';
    const violations = [];
    const sources = [appConfigFile, loopbackServerFile];

    for (const source of sources) {
        for (const entry of BROAD_BIND_PATTERNS) {
            if (entry.pattern.test(source.content)) {
                violations.push(violation(source.relPath, entry.message, expected));
            }
        }
    }

    if (!/requiredLocalEndpoint = \.hostPort\(host: NWEndpoint\.Host\(originHost\), port: port\)/.test(loopbackServerFile.content)) {
        violations.push(
            violation(
                loopbackServerFile.relPath,
                'loopback server must use requiredLocalEndpoint with the configured loopback host',
                expected
            )
        );
    }

    return violations;
}

function validateSensitiveLogging(loopbackServerFile) {
    const expected = 'Loopback is diagnostic-only scaffolding and must not log obvious sensitive material.';
    const violations = [];

    for (const entry of SENSITIVE_LOG_PATTERNS) {
        if (entry.pattern.test(loopbackServerFile.content)) {
            violations.push(violation(loopbackServerFile.relPath, entry.message, expected));
        }
    }

    return violations;
}

function printViolation(item) {
    console.log('[loopback-guard] violation');
    console.log(`  file: ${item.file}`);
    console.log(`  reason: ${item.reason}`);
    console.log(`  expected: ${item.expected}`);
}

async function main() {
    const { root } = parseArgs(process.argv.slice(2));
    const loopbackServerFile = await readFirstExisting(root, FILE_CANDIDATES.loopbackServer);

    console.log(`[loopback-guard] root: ${root}`);

    if (!loopbackServerFile) {
        console.log('[loopback-guard] info: no LocalLoopbackPayloadServer.swift found; skipping loopback containment checks');
        console.log('[loopback-guard] result: PASS');
        return;
    }

    const appConfigFile = await readFirstExisting(root, FILE_CANDIDATES.appConfig);
    const webContainerFile = await readFirstExisting(root, FILE_CANDIDATES.webContainer);
    const violations = [];

    if (!appConfigFile) {
        violations.push(
            violation(
                FILE_CANDIDATES.appConfig[0],
                'missing AppConfig.swift while loopback server exists',
                'Loopback is diagnostic-only scaffolding and must remain explicitly contained.'
            )
        );
    }
    if (!webContainerFile) {
        violations.push(
            violation(
                FILE_CANDIDATES.webContainer[0],
                'missing WebContainerViewController.swift while loopback server exists',
                'Loopback is diagnostic-only scaffolding and must remain explicitly contained.'
            )
        );
    }

    if (appConfigFile && webContainerFile) {
        violations.push(...validateLoopbackGating(appConfigFile, webContainerFile));
        violations.push(...validateBindHosts(appConfigFile, loopbackServerFile));
    }
    violations.push(...validateSensitiveLogging(loopbackServerFile));

    console.log(`[loopback-guard] loopback file: ${loopbackServerFile.relPath}`);

    if (violations.length === 0) {
        console.log('[loopback-guard] result: PASS');
        return;
    }

    for (const item of violations) {
        printViolation(item);
    }

    console.log('[loopback-guard] result: FAIL');
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[loopback-guard] result: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});