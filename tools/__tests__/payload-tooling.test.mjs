import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const assertNoProofDemoShellScript = path.join(repoRoot, 'tools', 'assert-no-proof-demo-shell.mjs');
const assertLoopbackContainmentScript = path.join(repoRoot, 'tools', 'assert-loopback-containment.mjs');
const assertWebpayloadDriftScript = path.join(repoRoot, 'tools', 'assert-webpayload-drift.mjs');
const validateMobilePayloadScript = path.join(repoRoot, 'tools', 'validate-mobile-payload.mjs');
const validatePyodideRuntimeScript = path.join(repoRoot, 'tools', 'validate-pyodide-runtime.mjs');
const fortwebManifestScript = path.join(repoRoot, 'tools', 'gen-fortweb-bundle-manifest.mjs');
const tempDirs = [];

async function makeTempDir() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fort-ios-tooling-'));
    tempDirs.push(tempDir);
    return tempDir;
}

async function writeTextFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

async function writeJsonFile(filePath, data) {
    await writeTextFile(filePath, JSON.stringify(data, null, 2) + '\n');
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
        const relPath = path.relative(payloadDir, absPath).replaceAll('\\', '/');
        if (relPath === 'build-manifest.json') {
            continue;
        }

        hash.update(relPath);
        hash.update('\n');
        hash.update(await readFile(absPath));
        hash.update('\n');
    }

    return hash.digest('hex');
}

async function runNodeScript(scriptPath, args) {
    return execFile('node', [scriptPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
}

async function runNodeScriptExpectFailure(scriptPath, args) {
    try {
        await runNodeScript(scriptPath, args);
    } catch (error) {
        return error;
    }

    throw new Error(`Expected ${path.basename(scriptPath)} to fail`);
}

async function writeLoopbackFixture(tempDir, options = {}) {
    const appConfigPath = path.join(tempDir, 'KeriWallet', 'AppConfig.swift');
    const webContainerPath = path.join(tempDir, 'KeriWallet', 'WebContainerViewController.swift');
    const loopbackServerPath = path.join(tempDir, 'xcodeproj', 'KeriWallet', 'KeriWallet', 'LocalLoopbackPayloadServer.swift');

    const host = options.host ?? '127.0.0.1';
    const loopbackEnumBody = options.loopbackEnumBody ?? `
        enum OriginMode {
            case appLocal
            case loopback
        }

        struct OriginSelection {
            let mode: OriginMode
            let reason: String
        }

        static let originModeEnvironmentKey = "FORTIOS_ORIGIN_MODE"
        static let environmentKey = "FORTIOS_LOOPBACK_ORIGIN"
        static let disableWorkaroundEnvironmentKey = "FORTIOS_DISABLE_LOOPBACK_WORKAROUND"
        static let launchArgument = "--fortios-loopback-origin"
        static let host = "${host}"
        static let pathPrefixSegment = "_fortios"

        static var isEnabled: Bool {
            originSelection.mode == .loopback
        }

        static var originSelection: OriginSelection {
            if false {
                return OriginSelection(mode: .appLocal, reason: "explicit_origin_mode_app_local")
            }
            if false {
                #if DEBUG
                    return OriginSelection(mode: .loopback, reason: "explicit_origin_mode_loopback")
                #else
                    return OriginSelection(mode: .appLocal, reason: "explicit_origin_mode_loopback_unavailable_release")
                #endif
            }
            if false {
                return OriginSelection(mode: .appLocal, reason: "invalid_origin_mode_app_local")
            }
            if false {
                return OriginSelection(mode: .appLocal, reason: "legacy_loopback_opt_out")
            }
            if false {
                #if DEBUG
                    return OriginSelection(mode: .loopback, reason: "legacy_loopback_opt_in")
                #else
                    return OriginSelection(mode: .appLocal, reason: "legacy_loopback_opt_in_unavailable_release")
                #endif
            }

            return OriginSelection(mode: .appLocal, reason: "app_local_default")
        }`;
    const webContainerGuard = options.webContainerGuard ?? `
        let originSelection = AppConfig.Loopback.originSelection
        _ = originSelection
        _ = WebNavigationPolicy(allowedLoopbackOrigin: initialPayloadTarget.loopbackOrigin)
        _ = LoopbackRuntimeOrigin(customScheme: false)
        _ = ["customScheme": false, "networkAllowed": false, "bundledAssetsOnly": true]`;
    const loopbackBody = options.loopbackBody ?? `
enum LocalLoopbackPayloadServerError: Error {
    case invalidURL
    case missingNoncePrefix
    case queryStringNotAllowed
}

final class LocalLoopbackPayloadServer {
    init(originHost: String = AppConfig.Loopback.host) {
        let parameters = NWParameters.tcp
        let port = NWEndpoint.Port(rawValue: 0)!
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(originHost), port: port)
        AppLogger.notice("[Loopback] loopback.server.ready host=\\"\\(originHost)\\"", category: AppConfig.Log.loopback)
    }

    func serve(request: Request, absoluteComponents: URLComponents, normalizedTarget: String, relativePath: String) throws {
        if absoluteComponents.percentEncodedQuery != nil {
            throw LocalLoopbackPayloadServerError.queryStringNotAllowed
        }
        if normalizedTarget.contains("?") {
            throw LocalLoopbackPayloadServerError.queryStringNotAllowed
        }
        if absoluteComponents.percentEncodedFragment != nil {
            throw LocalLoopbackPayloadServerError.invalidURL
        }
        if normalizedTarget.contains("#") {
            throw LocalLoopbackPayloadServerError.invalidURL
        }
        guard request.method == "GET" || request.method == "HEAD" else { return }
        guard allowedPayloadPaths.contains(relativePath) else { return }
        _ = fileURL.resolvingSymlinksInPath()
        guard decodedPath == currentOrigin.pathPrefix || decodedPath.hasPrefix("\\(currentOrigin.pathPrefix)/") else {
            throw LocalLoopbackPayloadServerError.missingNoncePrefix
        }
    }

    func displayURL(components: inout URLComponents) {
        components.percentEncodedQuery = nil
    }

    func generateNonce() {
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    }

    func matches(path: String, pathPrefix: String) -> Bool {
        path == pathPrefix || path.hasPrefix("\\(pathPrefix)/")
    }
}`;

    await writeTextFile(
        appConfigPath,
        `enum AppConfig {
    enum Loopback {
${loopbackEnumBody}
    }
}

// MARK: - Next section
`
    );
    await writeTextFile(
        webContainerPath,
        `final class WebContainerViewController {
    func resolveInitialPayloadTarget() {
        ${webContainerGuard}
    }
}
`
    );
    await writeTextFile(loopbackServerPath, loopbackBody);
}

function makeSharedManifest(overrides = {}) {
    return {
        producer: 'fortweb-shared',
        payload_profile: 'product-shell',
        entry_document: 'fortweb/app/index.html',
        entry_script: 'fortweb/app/app/main.js',
        build_command: 'PAYLOAD_SOURCE=fortweb ./sync-payload.sh',
        pyodide_worker_mode: 'pyscript-pyworker',
        pyodide_asset_path: '/fortweb/vendor/pyodide/0.29.3/pyodide.mjs',
        pyodide_asset_mode: 'esm',
        sync_targets: [{ id: 'ios-webpayload' }],
        source_git_branch: 'feature/test',
        source_git_status: 'clean',
        ...overrides,
    };
}

async function writeWebpayloadFixture(repoDir, manifestOverrides = {}, options = {}) {
    const payloadDir = path.join(repoDir, 'WebPayload');
    await writeTextFile(
        path.join(payloadDir, 'index.html'),
        '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
    );
    await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<main>fortweb</main>\n');
    await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'app', 'main.js'), 'export const boot = true;\n');

    const baseManifest = makeSharedManifest({
        build_command:
            'PAYLOAD_SOURCE=fortweb FORTWEB_FETCH=1 FORTWEB_REF=214643f4fa907061334c09c8297c4d1e59f18f45 ./sync-payload.sh',
        git_sha: '214643f4fa907061334c09c8297c4d1e59f18f45',
        sync_targets: [{ id: 'ios-webpayload', path: 'WebPayload', mutations: ['redirect_root_to_fortweb_app'] }],
    });
    const manifest = { ...baseManifest, ...manifestOverrides };

    if (options.omitEntryDocument) {
        await rm(path.join(payloadDir, 'fortweb', 'app', 'index.html'), { force: true });
    }

    if (!options.skipManifest) {
        if (!manifest.dist_tree_sha256) {
            manifest.dist_tree_sha256 = await hashPayloadTree(payloadDir);
        }
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), manifest);
    }

    if (options.malformedManifest) {
        await writeTextFile(path.join(payloadDir, 'build-manifest.json'), '{not-json\n');
    }

    return { payloadDir, manifest };
}

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
});

describe('validate-mobile-payload.mjs', () => {
    it('passes for a FortWeb shared payload manifest without blocked markers', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<h1>KERI Wallet</h1>');

        const { stdout } = await runNodeScript(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(stdout).toContain('[payload-check] result: PASS');
    });

    it('fails for a blocked manifest posture', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(
            path.join(payloadDir, 'build-manifest.json'),
            makeSharedManifest({
                producer: 'fort-ios-local',
                payload_profile: 'proof-shell',
            })
        );

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('fort-ios-local');
        expect(error.stdout).toContain('product-shell payload');
    });

    it('fails when legacy shell markers remain in the staged payload', async () => {
        const payloadDir = await makeTempDir();
        await writeJsonFile(path.join(payloadDir, 'build-manifest.json'), makeSharedManifest());
        await writeTextFile(
            path.join(payloadDir, 'index.html'),
            '<script>window.location.replace(\'./fortweb/app/index.html\');</script>'
        );
        await writeTextFile(path.join(payloadDir, 'fortweb', 'app', 'index.html'), '<p>Profile ID</p>');

        const error = await runNodeScriptExpectFailure(validateMobilePayloadScript, [
            '--payload-dir',
            payloadDir,
            '--target',
            'ios-webpayload',
        ]);

        expect(error.stdout).toContain('"Profile ID"');
        expect(error.stdout).toContain('[payload-check] result: FAIL');
    });
});

describe('assert-no-proof-demo-shell.mjs', () => {
    it('passes when the active repo surface contains no blocked posture strings', async () => {
        const repoDir = await makeTempDir();
        await writeTextFile(path.join(repoDir, 'src', 'main.ts'), 'export const status = "validation ready";\n');
        await writeTextFile(path.join(repoDir, 'README.md'), 'Fort-ios stages the FortWeb product-shell payload.\n');

        const { stdout } = await runNodeScript(assertNoProofDemoShellScript, ['--root', repoDir]);
        expect(stdout).toContain('[repo-guard] result: PASS');
    });

    it('fails when active source reintroduces a blocked fort-ios payload lane', async () => {
        const repoDir = await makeTempDir();
        await writeTextFile(path.join(repoDir, 'Makefile'), 'PAYLOAD_SOURCE=fort-ios make sync\n');

        const error = await runNodeScriptExpectFailure(assertNoProofDemoShellScript, ['--root', repoDir]);
        expect(error.stdout).toContain('PAYLOAD_SOURCE=fort-ios');
        expect(error.stdout).toContain('FortWeb product-shell payload');
    });
});

describe('assert-loopback-containment.mjs', () => {
    it('passes when no loopback server file exists', async () => {
        const repoDir = await makeTempDir();
        await writeTextFile(path.join(repoDir, 'KeriWallet', 'AppConfig.swift'), 'enum AppConfig {}\n');

        const { stdout } = await runNodeScript(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(stdout).toContain('no LocalLoopbackPayloadServer.swift found');
        expect(stdout).toContain('[loopback-guard] result: PASS');
    });

    it('passes for debug-gated loopback with 127.0.0.1', async () => {
        const repoDir = await makeTempDir();
        await writeLoopbackFixture(repoDir);

        const { stdout } = await runNodeScript(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(stdout).toContain('[loopback-guard] result: PASS');
    });

    it('fails when debug gating is missing', async () => {
        const repoDir = await makeTempDir();
        const ungatedLoopbackEnum = `
        enum OriginMode {
            case appLocal
            case loopback
        }

        struct OriginSelection {
            let mode: OriginMode
            let reason: String
        }

        static let originModeEnvironmentKey = "FORTIOS_ORIGIN_MODE"
        static let environmentKey = "FORTIOS_LOOPBACK_ORIGIN"
        static let disableWorkaroundEnvironmentKey = "FORTIOS_DISABLE_LOOPBACK_WORKAROUND"
        static let launchArgument = "--fortios-loopback-origin"
        static let host = "127.0.0.1"
        static let pathPrefixSegment = "_fortios"

        static var originSelection: OriginSelection {
            return OriginSelection(mode: .loopback, reason: "legacy_loopback_opt_in")
        }
        `;
        await writeLoopbackFixture(repoDir, {
            loopbackEnumBody: ungatedLoopbackEnum,
        });

        const error = await runNodeScriptExpectFailure(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(error.stdout).toContain('loopback opt-in must be Debug-gated');
        expect(error.stdout).toContain('[loopback-guard] result: FAIL');
    });

    it('fails when release loopback fallback is missing', async () => {
        const repoDir = await makeTempDir();
        const releaseFallbackMissing = `
        enum OriginMode {
            case appLocal
            case loopback
        }

        struct OriginSelection {
            let mode: OriginMode
            let reason: String
        }

        static let originModeEnvironmentKey = "FORTIOS_ORIGIN_MODE"
        static let environmentKey = "FORTIOS_LOOPBACK_ORIGIN"
        static let disableWorkaroundEnvironmentKey = "FORTIOS_DISABLE_LOOPBACK_WORKAROUND"
        static let launchArgument = "--fortios-loopback-origin"
        static let host = "127.0.0.1"
        static let pathPrefixSegment = "_fortios"

        static var originSelection: OriginSelection {
            #if DEBUG
                return OriginSelection(mode: .loopback, reason: "legacy_loopback_opt_in")
            #else
                return OriginSelection(mode: .loopback, reason: "legacy_loopback_opt_in")
            #endif
            return OriginSelection(mode: .appLocal, reason: "invalid_origin_mode_app_local")
            return OriginSelection(mode: .appLocal, reason: "app_local_default")
        }
        `;
        await writeLoopbackFixture(repoDir, {
            loopbackEnumBody: releaseFallbackMissing,
        });

        const error = await runNodeScriptExpectFailure(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(error.stdout).toContain('legacy loopback opt-in must fall back in Release builds');
        expect(error.stdout).toContain('[loopback-guard] result: FAIL');
    });

    it('fails when the bind host is 0.0.0.0', async () => {
        const repoDir = await makeTempDir();
        await writeLoopbackFixture(repoDir, { host: '0.0.0.0' });

        const error = await runNodeScriptExpectFailure(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(error.stdout).toContain('loopback host must be exactly 127.0.0.1');
        expect(error.stdout).toContain('must not bind 0.0.0.0');
        expect(error.stdout).toContain('[loopback-guard] result: FAIL');
    });

    it('fails when obvious sensitive logging markers appear', async () => {
        const repoDir = await makeTempDir();
        await writeLoopbackFixture(repoDir, {
            loopbackBody: `
final class LocalLoopbackPayloadServer {
    init(originHost: String = AppConfig.Loopback.host) {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(originHost), port: port)
        AppLogger.notice("requestBody=\\(requestBody) passcode=\\(passcode)", category: AppConfig.Log.loopback)
    }
}`,
        });

        const error = await runNodeScriptExpectFailure(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(error.stdout).toContain('loopback logging must not include request bodies');
        expect(error.stdout).toContain('loopback logging must not include passcodes');
        expect(error.stdout).toContain('[loopback-guard] result: FAIL');
    });

    it('fails when query strings are preserved instead of rejected', async () => {
        const repoDir = await makeTempDir();
        await writeLoopbackFixture(repoDir, {
            loopbackBody: `
final class LocalLoopbackPayloadServer {
    init(originHost: String = AppConfig.Loopback.host) {
        let parameters = NWParameters.tcp
        let port = NWEndpoint.Port(rawValue: 0)!
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(originHost), port: port)
    }

    func serve(request: Request, absoluteComponents: URLComponents, normalizedTarget: String, relativePath: String) {
        components.percentEncodedQuery = absoluteComponents.percentEncodedQuery
        guard request.method == "GET" || request.method == "HEAD" else { return }
        guard allowedPayloadPaths.contains(relativePath) else { return }
        _ = fileURL.resolvingSymlinksInPath()
    }

    func displayURL(components: inout URLComponents) {
        components.percentEncodedQuery = nil
    }

    func generateNonce() {
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    }

    func matches(path: String, pathPrefix: String) -> Bool {
        path == pathPrefix || path.hasPrefix("\\(pathPrefix)/")
    }
}`,
        });

        const error = await runNodeScriptExpectFailure(assertLoopbackContainmentScript, ['--root', repoDir]);
        expect(error.stdout).toContain('missing explicit query-string rejection policy');
        expect(error.stdout).toContain('loopback server must reject, not preserve, absolute-URL query strings');
        expect(error.stdout).toContain('[loopback-guard] result: FAIL');
    });
});

describe('assert-webpayload-drift.mjs', () => {
    it('passes for a valid staged WebPayload manifest and entry files', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir);

        const { stdout } = await runNodeScript(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(stdout).toContain('[webpayload-drift] result: PASS');
    });

    it('fails when the staged manifest is missing', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {}, { skipManifest: true });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('missing staged WebPayload build manifest');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });

    it('fails when the staged manifest is malformed', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {}, { malformedManifest: true });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('malformed JSON in staged WebPayload manifest');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });

    it('fails when producer or payload profile drift from the mobile contract', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {
            producer: 'fort-ios-local',
            payload_profile: 'proof-shell',
        });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('producer drift');
        expect(error.stdout).toContain('payload profile drift');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });

    it('fails when a manifest-declared payload entry file is missing', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {}, { omitEntryDocument: true });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('staged WebPayload is missing a manifest-declared entry file');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });

    it('fails when the staged tree hash drifts from the manifest', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {
            dist_tree_sha256: 'deadbeef',
        });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('staged WebPayload tree hash drift');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });

    it('fails when the pinned FortWeb ref in build_command disagrees with git_sha', async () => {
        const repoDir = await makeTempDir();
        const { payloadDir } = await writeWebpayloadFixture(repoDir, {
            git_sha: 'ffffffffffffffffffffffffffffffffffffffff',
        });

        const error = await runNodeScriptExpectFailure(assertWebpayloadDriftScript, [
            '--root',
            repoDir,
            '--payload-dir',
            payloadDir,
        ]);

        expect(error.stdout).toContain('git SHA drift');
        expect(error.stdout).toContain('[webpayload-drift] result: FAIL');
    });
});

describe('validate-pyodide-runtime.mjs', () => {
    it('passes for a module worker paired with an ESM pyodide asset', async () => {
        const payloadDir = await makeTempDir();
        const workerPath = path.join(payloadDir, 'pyodide_worker.ts');
        const assetPath = path.join(payloadDir, 'pyodide.mjs');

        await writeTextFile(
            workerPath,
            "const pyodideModule = await import('./pyodide.mjs');\nexport const load = pyodideModule.loadPyodide;\n"
        );
        await writeTextFile(assetPath, 'export function loadPyodide() { return true; }\n');

        const { stdout } = await runNodeScript(validatePyodideRuntimeScript, [
            '--worker',
            workerPath,
            '--asset',
            assetPath,
        ]);

        expect(stdout).toContain('[pyodide-check] detected worker mode: module');
        expect(stdout).toContain('[pyodide-check] detected pyodide asset mode: esm');
        expect(stdout).toContain('[pyodide-check] result: PASS');
    });

    it('fails for a classic worker paired with an ESM pyodide asset', async () => {
        const payloadDir = await makeTempDir();
        const workerPath = path.join(payloadDir, 'pyodide_worker.ts');
        const assetPath = path.join(payloadDir, 'pyodide.js');

        await writeTextFile(workerPath, "importScripts('./pyodide.js');\n");
        await writeTextFile(assetPath, 'export function loadPyodide() { return true; }\n');

        const error = await runNodeScriptExpectFailure(validatePyodideRuntimeScript, [
            '--worker',
            workerPath,
            '--asset',
            assetPath,
        ]);

        expect(error.stdout).toContain('[pyodide-check] detected worker mode: classic');
        expect(error.stdout).toContain('[pyodide-check] detected pyodide asset mode: esm');
        expect(error.stdout).toContain('[pyodide-check] result: FAIL');
    });
});

describe('gen-fortweb-bundle-manifest.mjs', () => {
    it('writes the expected wrapper manifest fields for the FortWeb payload', async () => {
        const payloadRoot = await makeTempDir();
        const fortwebDir = await makeTempDir();

        await writeTextFile(path.join(payloadRoot, 'index.html'), '<!doctype html>\n');
        await writeTextFile(path.join(payloadRoot, 'fortweb', 'app', 'index.html'), '<main>fortweb</main>\n');
        await writeTextFile(
            path.join(fortwebDir, 'pyscript-ci.toml'),
            'interpreter = "/fortweb/vendor/pyodide/custom.mjs"\n'
        );

        await runNodeScript(fortwebManifestScript, [
            '--payload-root',
            payloadRoot,
            '--fortweb-dir',
            fortwebDir,
            '--build-command',
            'PAYLOAD_SOURCE=fortweb ./sync-payload.sh',
        ]);

        const manifest = JSON.parse(
            await readFile(path.join(payloadRoot, 'build-manifest.json'), 'utf8')
        );

        expect(manifest.producer).toBe('fortweb-shared');
        expect(manifest.payload_profile).toBe('product-shell');
        expect(manifest.entry_document).toBe('fortweb/app/index.html');
        expect(manifest.pyodide_asset_path).toBe('/fortweb/vendor/pyodide/custom.mjs');
        expect(manifest.sync_targets.map((entry) => entry.id)).toEqual(['ios-webpayload']);
    });
});
