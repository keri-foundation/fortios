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

function extractEnumBody(source, enumName) {
    const enumStart = source.indexOf(`enum ${enumName}`);
    if (enumStart < 0) {
        return null;
    }

    const bodyStart = source.indexOf('{', enumStart);
    if (bodyStart < 0) {
        return null;
    }

    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{') {
            depth += 1;
        }
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(bodyStart + 1, index);
            }
        }
    }

    return null;
}

function requiredProbe(file, pattern, reason) {
    return { file, pattern, reason, kind: 'required' };
}

function forbiddenProbe(file, pattern, reason) {
    return { file, pattern, reason, kind: 'forbidden' };
}

function collectProbeViolations(probes, expected) {
    const violations = [];
    for (const probe of probes) {
        const matches = probe.pattern.test(probe.file.content);
        if ((probe.kind === 'required' && !matches) || (probe.kind === 'forbidden' && matches)) {
            violations.push(violation(probe.file.relPath, probe.reason, expected));
        }
    }
    return violations;
}

function validateLoopbackGating(appConfigFile, webContainerFile) {
    const violations = [];
    const loopbackEnum = extractEnumBody(appConfigFile.content, 'Loopback');
    const expected = 'Loopback must be explicit diagnostic scaffolding: app-local default, Debug-only opt-in loopback, Release fallback to app-local.';

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

    if (!loopbackEnum.includes('static let originModeEnvironmentKey = "FORTIOS_ORIGIN_MODE"')) {
        violations.push(
            violation(appConfigFile.relPath, 'missing FORTIOS_ORIGIN_MODE selector', expected)
        );
    }

    if (!/enum OriginMode \{[\s\S]*case appLocal[\s\S]*case loopback/.test(loopbackEnum)) {
        violations.push(
            violation(appConfigFile.relPath, 'missing explicit app-local and loopback origin modes', expected)
        );
    }

    if (/return OriginSelection\(mode: \.loopback, reason: "production_candidate_default"\)/.test(loopbackEnum)) {
        violations.push(
            violation(
                appConfigFile.relPath,
                'loopback must not be the production-candidate default origin',
                expected
            )
        );
    }

    if (!/return OriginSelection\(mode: \.appLocal, reason: "app_local_default"\)/.test(loopbackEnum)) {
        violations.push(
            violation(appConfigFile.relPath, 'app-local must be the fallback default origin', expected)
        );
    }

    if (!loopbackEnum.includes('#if DEBUG')) {
        violations.push(
            violation(appConfigFile.relPath, 'loopback opt-in must be Debug-gated', expected)
        );
    }

    if (!loopbackEnum.includes('explicit_origin_mode_loopback_unavailable_release')) {
        violations.push(
            violation(
                appConfigFile.relPath,
                'explicit loopback origin mode must fall back in Release builds',
                expected
            )
        );
    }

    if (!loopbackEnum.includes('legacy_loopback_opt_in_unavailable_release')) {
        violations.push(
            violation(
                appConfigFile.relPath,
                'legacy loopback opt-in must fall back in Release builds',
                expected
            )
        );
    }

    if (!loopbackEnum.includes('invalid_origin_mode_app_local')) {
        violations.push(
            violation(appConfigFile.relPath, 'invalid origin mode must fail closed to app-local', expected)
        );
    }

    if (!loopbackEnum.includes('disableWorkaroundEnvironmentKey')) {
        violations.push(
            violation(appConfigFile.relPath, 'missing legacy app-local opt-out compatibility', expected)
        );
    }

    if (!loopbackEnum.includes('environmentKey')) {
        violations.push(
            violation(appConfigFile.relPath, 'missing explicit legacy loopback opt-in compatibility', expected)
        );
    }

    if (!webContainerFile.content.includes('let originSelection = AppConfig.Loopback.originSelection')) {
        violations.push(
            violation(
                webContainerFile.relPath,
                'web container must route origin selection through AppConfig.Loopback.originSelection',
                expected
            )
        );
    }

    return violations;
}

function validateBindHosts(appConfigFile, loopbackServerFile) {
    const expected = 'Hardened loopback must bind only to 127.0.0.1 on an OS-assigned random port.';
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

    if (!/NWEndpoint\.Port\(rawValue: 0\)/.test(loopbackServerFile.content)) {
        violations.push(
            violation(
                loopbackServerFile.relPath,
                'loopback server must request an OS-assigned random port with port 0',
                expected
            )
        );
    }

    return violations;
}

function validateHardenedServing(appConfigFile, webContainerFile, loopbackServerFile) {
    const expected = 'Hardened loopback must serve static bundled payload files only under a nonce-prefixed path.';
    const violations = [];

    const required = [
        requiredProbe(appConfigFile, /static let pathPrefixSegment = "_fortios"/, 'missing fixed hardened path-prefix segment'),
        requiredProbe(loopbackServerFile, /SecRandomCopyBytes\(kSecRandomDefault, bytes\.count, &bytes\)/, 'missing cryptographic per-launch nonce generation'),
        requiredProbe(loopbackServerFile, /missingNoncePrefix/, 'missing rejection for requests without the nonce path prefix'),
        requiredProbe(loopbackServerFile, /queryStringNotAllowed/, 'missing explicit query-string rejection policy'),
        requiredProbe(loopbackServerFile, /percentEncodedQuery\s*!=\s*nil/, 'missing absolute-URL query rejection'),
        requiredProbe(loopbackServerFile, /normalizedTarget\.contains\("\?"\)/, 'missing origin-form query rejection'),
        requiredProbe(loopbackServerFile, /percentEncodedFragment\s*!=\s*nil/, 'missing absolute-URL fragment rejection'),
        requiredProbe(loopbackServerFile, /normalizedTarget\.contains\("#"\)/, 'missing origin-form fragment rejection'),
        requiredProbe(loopbackServerFile, /request\.method == "GET" \|\| request\.method == "HEAD"/, 'missing GET and HEAD method allowlist'),
        requiredProbe(loopbackServerFile, /allowedPayloadPaths\.contains\(relativePath\)/, 'missing static payload file allowlist check'),
        requiredProbe(loopbackServerFile, /resolvingSymlinksInPath\(\)/, 'missing symlink-aware payload containment check'),
        requiredProbe(loopbackServerFile, /components\.percentEncodedQuery = nil/, 'request logging must strip query strings'),
        requiredProbe(webContainerFile, /customScheme: false/, 'loopback runtime-origin contract must report customScheme=false'),
        requiredProbe(webContainerFile, /networkAllowed": false/, 'runtime-origin contract must keep networkAllowed=false'),
        requiredProbe(webContainerFile, /bundledAssetsOnly": true/, 'runtime-origin contract must keep bundledAssetsOnly=true'),
    ];

    const forbidden = [
        forbiddenProbe(loopbackServerFile, /components\.percentEncodedQuery = absoluteComponents\.percentEncodedQuery/, 'loopback server must reject, not preserve, absolute-URL query strings'),
        forbiddenProbe(loopbackServerFile, /components\.percentEncodedQuery = String\(/, 'loopback server must reject, not preserve, origin-form query strings'),
    ];

    violations.push(...collectProbeViolations(required, expected));
    violations.push(...collectProbeViolations(forbidden, expected));

    return violations;
}

function validateNavigationContainment(webContainerFile, loopbackServerFile) {
    const expected = 'Navigation policy must allow only the active loopback origin and nonce-prefixed payload paths.';
    const violations = [];

    if (!/allowedLoopbackOrigin: initialPayloadTarget\.loopbackOrigin/.test(webContainerFile.content)) {
        violations.push(
            violation(
                webContainerFile.relPath,
                'web container must pass the active loopback origin into the navigation policy',
                expected
            )
        );
    }

    if (!/path == pathPrefix \|\| path\.hasPrefix\("\\\(pathPrefix\)\/"\)/.test(loopbackServerFile.content)) {
        violations.push(
            violation(
                loopbackServerFile.relPath,
                'LoopbackOrigin.matches must require the nonce path prefix, not just host and port',
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
        violations.push(...validateHardenedServing(appConfigFile, webContainerFile, loopbackServerFile));
        violations.push(...validateNavigationContainment(webContainerFile, loopbackServerFile));
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