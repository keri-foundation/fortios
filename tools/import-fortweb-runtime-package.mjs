import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const payloadDir = path.join(repoRoot, 'WebPayload');
const packageRootName = 'fortweb-runtime';
const packageRootPrefix = `${packageRootName}/`;
const tempRootPrefix = path.join(os.tmpdir(), 'fort-ios-runtime-import-');
const validateMobilePayloadScript = path.join(repoRoot, 'tools', 'validate-mobile-payload.mjs');
const assertWebpayloadDriftScript = path.join(repoRoot, 'tools', 'assert-webpayload-drift.mjs');
const payloadTarget = 'ios-webpayload';

const requiredZipEntries = [
    `${packageRootPrefix}`,
    `${packageRootPrefix}manifest.json`,
    `${packageRootPrefix}checksums.sha256`,
    `${packageRootPrefix}app/app/main.js`,
    `${packageRootPrefix}vendor/`,
];

function usage() {
    console.error('Usage: node tools/import-fortweb-runtime-package.mjs <fortweb-runtime.zip>');
}

function fail(message) {
    throw new Error(message);
}

function sha256Hex(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function normalizeZipEntry(entry) {
    if (typeof entry !== 'string' || entry.length === 0) {
        fail('ZIP entry names must be non-empty strings.');
    }

    if (entry.startsWith('/') || entry.startsWith('\\')) {
        fail(`ZIP entry uses an absolute path: ${entry}`);
    }

    if (entry.includes('\\')) {
        fail(`ZIP entry uses a Windows path separator: ${entry}`);
    }

    const normalized = path.posix.normalize(entry);
    if (normalized !== entry) {
        fail(`ZIP entry is non-canonical or contains traversal: ${entry}`);
    }

    if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        fail(`ZIP entry contains path traversal: ${entry}`);
    }

    return normalized;
}

async function listZipEntries(zipPath) {
    const { stdout } = await execFile('unzip', ['-Z1', zipPath], {
        cwd: repoRoot,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
    });

    return stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalizeZipEntry);
}

async function extractZip(zipPath, targetDir) {
    await execFile('unzip', ['-q', zipPath, '-d', targetDir], {
        cwd: repoRoot,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
    });
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

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readInterpreterPath(fortwebPackageDir) {
    const pyscriptConfig = await readFile(path.join(fortwebPackageDir, 'pyscript-ci.toml'), 'utf8');
    const match = pyscriptConfig.match(/^interpreter\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? '/fortweb/vendor/pyodide/0.29.3/pyodide.mjs';
}

async function validatePackageContents(packageDir) {
    const manifestPath = path.join(packageDir, 'manifest.json');
    const checksumsPath = path.join(packageDir, 'checksums.sha256');
    const manifest = await readJson(manifestPath);
    const manifestBytes = await readFile(manifestPath);
    const manifestSha256 = sha256Hex(manifestBytes);
    const checksumsText = (await readFile(checksumsPath, 'utf8')).trim();

    if (checksumsText !== `${manifestSha256}  manifest.json`) {
        fail('Manifest checksum mismatch in imported runtime package.');
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        fail('Imported runtime manifest must be a JSON object.');
    }

    if (manifest.packageName !== packageRootName) {
        fail(`Unexpected packageName: ${manifest.packageName ?? 'missing'}`);
    }

    if (manifest.basePath !== '/fortweb/app/') {
        fail(`Unexpected basePath: ${manifest.basePath ?? 'missing'}`);
    }

    if (manifest.entrypoint !== 'app/index.html') {
        fail(`Unexpected entrypoint: ${manifest.entrypoint ?? 'missing'}`);
    }

    if (!Array.isArray(manifest.files)) {
        fail('Imported runtime manifest must include a files array.');
    }

    const manifestFiles = new Map();
    for (const [index, fileEntry] of manifest.files.entries()) {
        if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
            fail(`Manifest file entry #${index + 1} must be an object.`);
        }

        const relPath = normalizeZipEntry(fileEntry.path);
        if (!/^[0-9a-f]{64}$/u.test(String(fileEntry.sha256 ?? ''))) {
            fail(`Invalid SHA-256 for ${relPath}`);
        }
        if (!Number.isInteger(fileEntry.bytes) || fileEntry.bytes < 0) {
            fail(`Invalid byte size for ${relPath}`);
        }
        if (manifestFiles.has(relPath)) {
            fail(`Duplicate manifest entry: ${relPath}`);
        }

        manifestFiles.set(relPath, {
            sha256: fileEntry.sha256,
            bytes: fileEntry.bytes,
        });
    }

    for (const requiredEntry of requiredZipEntries) {
        if (requiredEntry.endsWith('/')) {
            const directoryPath = path.join(packageDir, requiredEntry.slice(packageRootPrefix.length, -1));
            const directoryStat = await lstat(directoryPath).catch(() => null);
            if (!directoryStat || !directoryStat.isDirectory()) {
                fail(`Missing required directory: ${requiredEntry}`);
            }
            continue;
        }

        const filePath = path.join(packageDir, requiredEntry.slice(packageRootPrefix.length));
        const fileStat = await lstat(filePath).catch(() => null);
        if (!fileStat || !fileStat.isFile()) {
            fail(`Missing required file: ${requiredEntry}`);
        }
    }

    const actualFiles = await listFilesRec(packageDir);
    const actualRelativeFiles = actualFiles.map((absPath) => path.relative(packageDir, absPath).replaceAll('\\', '/'));
    const allowedFiles = new Set(['manifest.json', 'checksums.sha256', ...manifestFiles.keys()]);
    const unexpectedFiles = actualRelativeFiles.filter((relPath) => !allowedFiles.has(relPath));

    if (unexpectedFiles.length > 0) {
        fail(`Imported runtime package contains unexpected files: ${unexpectedFiles.join(', ')}`);
    }

    for (const [relPath, meta] of manifestFiles.entries()) {
        const absPath = path.join(packageDir, relPath);
        const fileBytes = await readFile(absPath);
        const fileStat = await lstat(absPath);
        const fileSha256 = sha256Hex(fileBytes);

        if (fileStat.size !== meta.bytes) {
            fail(`Byte size mismatch for ${relPath}: expected ${meta.bytes}, found ${fileStat.size}`);
        }

        if (fileSha256 !== meta.sha256) {
            fail(`SHA-256 mismatch for ${relPath}`);
        }
    }

    return manifest;
}

async function clearDirectory(absDir) {
    await mkdir(absDir, { recursive: true });
    const entries = await readdir(absDir, { withFileTypes: true });

    for (const entry of entries) {
        await rm(path.join(absDir, entry.name), { recursive: true, force: true });
    }
}

async function copyEntry(sourcePath, targetPath) {
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        const entries = await readdir(sourcePath, { withFileTypes: true });
        for (const entry of entries) {
            await copyEntry(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
        }
        return;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { force: true });
}

async function hashPayloadTree(absDir) {
    const files = await listFilesRec(absDir);
    files.sort((left, right) => left.localeCompare(right));

    const hash = createHash('sha256');
    for (const absPath of files) {
        const relPath = path.relative(absDir, absPath).replaceAll('\\', '/');
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

async function writeRootIndex() {
    await writeFile(
        path.join(payloadDir, 'index.html'),
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>KERI Wallet</title>
  <script>
    window.location.replace('./fortweb/app/index.html');
  </script>
</head>
<body></body>
</html>
`,
        'utf8'
    );
}

async function readExistingShellIndexHtml() {
    const shellIndexPath = path.join(payloadDir, 'fortweb', 'app', 'index.html');
    const shellIndexStat = await lstat(shellIndexPath).catch(() => null);
    if (shellIndexStat && shellIndexStat.isFile()) {
        return readFile(shellIndexPath, 'utf8');
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no">
    <title>Fortweb Wallet Shell</title>
    <link rel="stylesheet" href="./styles/tokens.css">
    <link rel="stylesheet" href="./styles/base.css">
    <link rel="stylesheet" href="./styles/layout.css">
    <link rel="stylesheet" href="./styles/components.css">
    <script type="module" src="../vendor/pyscript/2025.11.2/core.js"></script>
</head>
<body>
    <div id="app-root"></div>
    <script type="module" src="./app/main.js"></script>
</body>
</html>`;
}

async function writeBuildManifest(zipPath, runtimeManifest, fortwebPackageDir) {
    const manifest = {
        schema: 2,
        created_at: new Date().toISOString(),
        package_name: 'fortweb-wallet',
        producer: 'fortweb-shared',
        payload_profile: 'product-shell',
        entry_document: 'fortweb/app/index.html',
        entry_script: 'fortweb/app/app/main.js',
        build_command: `PAYLOAD_SOURCE=fortweb FORTIOS_RUNTIME_ZIP=${zipPath} node tools/import-fortweb-runtime-package.mjs ${zipPath}`,
        git_sha: runtimeManifest.gitSha ?? runtimeManifest.git_sha ?? null,
        source_git_branch: runtimeManifest.gitRef ?? runtimeManifest.git_ref ?? runtimeManifest.source_git_branch ?? 'unknown',
        source_git_status: runtimeManifest.source_git_status ?? 'clean',
        node_version: process.version,
        npm_user_agent: process.env.npm_config_user_agent ?? null,
        package_lock_sha256: null,
        pyodide_worker_mode: 'pyscript-pyworker',
        pyodide_asset_path: await readInterpreterPath(fortwebPackageDir),
        pyodide_asset_mode: 'esm',
        sync_targets: [
            {
                id: payloadTarget,
                path: 'WebPayload',
                mutations: ['redirect_root_to_fortweb_app'],
            },
        ],
    };

    manifest.dist_tree_sha256 = await hashPayloadTree(payloadDir);

    await writeFile(path.join(payloadDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

async function runValidationScripts() {
    await execFile('node', [validateMobilePayloadScript, '--payload-dir', payloadDir, '--target', payloadTarget], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });

    await execFile('node', [assertWebpayloadDriftScript, '--root', repoRoot, '--payload-dir', payloadDir, '--target', payloadTarget], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });
}

async function main() {
    if (process.argv.length !== 3) {
        usage();
        process.exitCode = 1;
        return;
    }

    const zipPath = path.resolve(process.cwd(), process.argv[2]);
    const zipStat = await lstat(zipPath).catch(() => null);
    if (!zipStat || !zipStat.isFile()) {
        fail(`ZIP not found: ${zipPath}`);
    }

    const zipEntries = await listZipEntries(zipPath);
    for (const requiredEntry of requiredZipEntries) {
        if (!zipEntries.includes(requiredEntry)) {
            fail(`Runtime ZIP missing required entry: ${requiredEntry}`);
        }
    }

    const tempRoot = await mkdtemp(tempRootPrefix);
    const extractRoot = path.join(tempRoot, 'extract');
    await mkdir(extractRoot, { recursive: true });

    try {
        await extractZip(zipPath, extractRoot);

        const extractedRoot = path.join(extractRoot, packageRootName);
        const extractedStat = await lstat(extractedRoot).catch(() => null);
        if (!extractedStat || !extractedStat.isDirectory()) {
            fail(`Extracted package missing expected root directory: ${packageRootPrefix}`);
        }

        const runtimeManifest = await validatePackageContents(extractedRoot);

        const shellIndexHtml = await readExistingShellIndexHtml();
        await clearDirectory(path.join(payloadDir, 'fortweb'));
        const fortwebPayloadDir = path.join(payloadDir, 'fortweb');
        await mkdir(fortwebPayloadDir, { recursive: true });

        const directoryEntries = await readdir(extractedRoot, { withFileTypes: true });
        for (const entry of directoryEntries) {
            await copyEntry(path.join(extractedRoot, entry.name), path.join(fortwebPayloadDir, entry.name));
        }

        const fortwebIndexPath = path.join(fortwebPayloadDir, 'app', 'index.html');
        if (!shellIndexHtml.includes('./app/main.js')) {
            fail('Imported runtime app/index.html does not reference ./app/main.js');
        }
        await writeFile(fortwebIndexPath, shellIndexHtml, 'utf8');

        await writeRootIndex();
        const buildManifest = await writeBuildManifest(zipPath, runtimeManifest, fortwebPayloadDir);

        await runValidationScripts();

        const fileCount = (await listFilesRec(payloadDir)).length;
        console.log(`[import-fortweb-runtime] ok zip=${zipPath}`);
        console.log(`[import-fortweb-runtime] git_sha=${buildManifest.git_sha ?? 'missing'}`);
        console.log(`[import-fortweb-runtime] files=${fileCount}`);
        console.log(`[import-fortweb-runtime] payload_dir=${payloadDir}`);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

await main().catch((error) => {
    console.error(`[import-fortweb-runtime] ${error.message}`);
    process.exitCode = 1;
});
