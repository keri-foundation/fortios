/**
 * Adversarial ZIP fixture helper — test-only, not a production dependency.
 *
 * Uses Python's zipfile module (already installed in macOS dev environments)
 * to create ZIP archives with paths and structures that the system `zip`
 * command cannot or will not produce.
 *
 * All fixtures are written to temporary directories. Never committed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Run a Python script that creates a ZIP. The script receives:
 *   zip_path = sys.argv[1]     — destination ZIP path
 *   content_dir = sys.argv[2]  — directory of files to include (or empty dir)
 *
 * @param {string} tempDir - scratch directory
 * @param {string} zipName - basename of the output ZIP
 * @param {string} pythonCode - Python code string (receives zip_path, content_dir)
 * @param {object} [contentFiles] - map of relative-path → content to pre-create
 * @returns {string} absolute path to the created ZIP
 *
 * @private — module-internal base factory used by the exported helpers below.
 */
function createAdversarialZip(tempDir, zipName, pythonCode, contentFiles = {}) {
  const zipPath = path.join(tempDir, zipName);
  const contentDir = path.join(tempDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  // Pre-create any content files
  for (const [relPath, content] of Object.entries(contentFiles)) {
    const fullPath = path.join(contentDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  const script = `
import zipfile, os, sys, stat

zip_path = os.environ['ZIP_PATH']
content_dir = os.environ['CONTENT_DIR']

${pythonCode}
`;

  execFileSync('python3', ['-c', script], {
    env: { ...process.env, ZIP_PATH: zipPath, CONTENT_DIR: contentDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return zipPath;
}

/**
 * Create a ZIP entry that is a symlink.
 *
 * @param {string} tempDir
 * @param {string} zipName
 * @param {string} symlinkPath - path inside the ZIP for the symlink entry
 * @param {string} targetPath - symlink target (can be absolute or relative)
 * @returns {string} ZIP path
 */
export function createSymlinkZip(tempDir, zipName, symlinkPath, targetPath) {
  const pythonCode = `
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
    info = zipfile.ZipInfo('${symlinkPath}')
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    zf.writestr(info, '${targetPath}')
`;
  return createAdversarialZip(tempDir, zipName, pythonCode);
}

/**
 * Create a ZIP with duplicate entries (same path twice).
 *
 * @param {string} tempDir
 * @param {string} zipName
 * @param {string} dupPath - the path to duplicate
 * @returns {string} ZIP path
 */
export function createDuplicateEntryZip(tempDir, zipName, dupPath) {
  const pythonCode = `
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
    zf.writestr('${dupPath}', 'first')
    zf.writestr('${dupPath}', 'second')
`;
  return createAdversarialZip(tempDir, zipName, pythonCode);
}

/**
 * Create a ZIP with a directory symlink entry.
 *
 * @param {string} tempDir
 * @param {string} zipName
 * @param {string} symlinkPath - path inside ZIP
 * @param {string} targetPath - symlink target
 * @returns {string} ZIP path
 */
export function createDirSymlinkZip(tempDir, zipName, symlinkPath, targetPath) {
  const pythonCode = `
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
    info = zipfile.ZipInfo('${symlinkPath}/')
    info.external_attr = (stat.S_IFLNK | stat.S_IFDIR | 0o777) << 16
    zf.writestr(info, '${targetPath}')
`;
  return createAdversarialZip(tempDir, zipName, pythonCode);
}

/**
 * Create a valid-looking package ZIP with arbitrary entries.
 * Each entry is { path, content }.
 * Content is written as STRING (UTF-8).
 *
 * @param {string} tempDir
 * @param {string} zipName
 * @param {Array<{path: string, content: string}>} entries
 * @returns {string} ZIP path
 */
export function createArbitraryZip(tempDir, zipName, entries) {
  const pythonCode = `
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
${entries.map(e => `    zf.writestr('${e.path}', '''${e.content.replace(/'/g, "\\'")}''')`).join('\n')}
`;
  return createAdversarialZip(tempDir, zipName, pythonCode);
}
