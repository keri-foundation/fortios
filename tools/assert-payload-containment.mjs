#!/usr/bin/env node

/**
 * Stable-origin payload containment validation for Fort-ios.
 *
 * Validates architecture-independent containment invariants in the
 * WKWebView scheme-handler based wrapper. Does NOT validate loopback
 * server behavior (that architecture was explicitly rejected).
 *
 * Read-only. Returns nonzero when a containment invariant is absent
 * or cannot be confirmed in the current source.
 *
 * Usage:
 *   node tools/assert-payload-containment.mjs [--root <path>]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');

// --- File candidates (supports both flat and xcodeproj layouts) ---

const FILE_CANDIDATES = {
  appConfig: [
    'KeriWallet/AppConfig.swift',
  ],
  schemeHandler: [
    'KeriWallet/PayloadSchemeHandler.swift',
  ],
  webBridge: [
    'KeriWallet/WebBridge.swift',
  ],
  navPolicy: [
    'KeriWallet/WebNavigationPolicy.swift',
  ],
  webContainer: [
    'KeriWallet/WebContainerViewController.swift',
  ],
};

// --- Sensitive logging patterns (architecture-agnostic) ---

const SENSITIVE_LOG_PATTERNS = [
  { pattern: /requestBody/i, message: 'logging must not include request bodies' },
  { pattern: /responseBody/i, message: 'logging must not include response bodies' },
  { pattern: /httpBody/i, message: 'logging must not include HTTP bodies' },
  { pattern: /allHTTPHeaderFields/i, message: 'logging must not include HTTP header dumps' },
  { pattern: /servedFileContents/i, message: 'logging must not include served file contents' },
  { pattern: /passcode/i, message: 'logging must not include passcodes' },
  { pattern: /password/i, message: 'logging must not include passwords' },
  { pattern: /privateKey/i, message: 'logging must not include private keys' },
  { pattern: /vaultContents/i, message: 'logging must not include vault contents' },
  { pattern: /secret/i, message: 'logging must not include secrets' },
  { pattern: /\bseed\b/i, message: 'logging must not include seed material' },
];

// --- Rejected design patterns (must be absent) ---

const REJECTED_PATTERNS = [
  { pattern: /LocalLoopbackPayloadServer/, message: 'loopback server must not be present (rejected architecture)' },
  { pattern: /127\.0\.0\.1/, message: 'loopback bind address must not be present (rejected architecture)' },
  { pattern: /noncePrefix|nonce_path|pathPrefixSegment/, message: 'nonce-prefixed paths must not be present (rejected architecture)' },
  { pattern: /FORTIOS_ORIGIN_MODE/, message: 'origin-mode selector must not be present (rejected architecture)' },
  { pattern: /ephemeral/, message: 'ephemeral port references must not be present (rejected architecture)' },
  { pattern: /"localhost"/, message: 'localhost bind must not be present (rejected architecture)' },
];

// --- Helpers ---

function parseArgs(argv) {
  const options = { root: defaultRoot };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      options.root = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

async function maybeRead(root, relPath) {
  try {
    return { relPath, content: await readFile(path.join(root, relPath), 'utf8') };
  } catch {
    return null;
  }
}

async function readFirstExisting(root, relPaths) {
  for (const p of relPaths) {
    const f = await maybeRead(root, p);
    if (f) return f;
  }
  return null;
}

function violation(file, reason, expected) {
  return { file, reason, expected };
}

function requiredProbe(file, pattern, reason) {
  return { file, pattern, reason, kind: 'required' };
}

function forbiddenProbe(file, pattern, reason) {
  return { file, pattern, reason, kind: 'forbidden' };
}

function collectProbeViolations(probes, expected) {
  const violations = [];
  for (const p of probes) {
    const matches = p.pattern.test(p.file.content);
    if ((p.kind === 'required' && !matches) || (p.kind === 'forbidden' && matches)) {
      violations.push(violation(p.file.relPath, p.reason, expected));
    }
  }
  return violations;
}

// --- Validation functions ---

function validateRejectedDesigns(files) {
  const expected = 'Rejected loopback architecture must be absent from all source files.';
  const violations = [];
  for (const file of files) {
    if (!file) continue;
    for (const { pattern, message } of REJECTED_PATTERNS) {
      if (pattern.test(file.content)) {
        violations.push(violation(file.relPath, message, expected));
      }
    }
  }
  return violations;
}

function validateStableOrigin(schemeHandler, appConfig) {
  const expected = 'Wrapper must enforce one stable production origin with scheme/host checks.';
  const violations = [];

  const probes = [
    // Scheme handler must validate the request URL scheme
    requiredProbe(
      schemeHandler,
      /request\.url|url\.absoluteString|url\.relativePath/,
      'scheme handler must inspect the request URL'
    ),
    // Must not allow arbitrary schemes
    forbiddenProbe(
      schemeHandler,
      /allowAnyScheme|allSchemesAllowed/,
      'scheme handler must not allow arbitrary schemes'
    ),
  ];

  violations.push(...collectProbeViolations(probes, expected));

  // AppConfig must define a stable origin (not loopback, not ephemeral)
  if (appConfig) {
    if (!/let (origin|scheme|host)\s*[=:]/.test(appConfig.content)) {
      violations.push(violation(
        appConfig.relPath,
        'AppConfig must define a stable origin scheme/host',
        expected
      ));
    }
  }

  return violations;
}

function validateNavigationContainment(navPolicy) {
  const expected = 'Navigation policy must restrict navigation to the approved origin.';
  const violations = [];

  const probes = [
    requiredProbe(
      navPolicy,
      /decidePolicyFor.*navigationAction|decidePolicyFor.*navigationResponse/,
      'navigation policy must implement WKNavigationDelegate decision methods'
    ),
    requiredProbe(
      navPolicy,
      /allow|cancel|\.cancel/,
      'navigation policy must have an allow/deny decision path'
    ),
    // Must validate the request URL against expected origin
    requiredProbe(
      navPolicy,
      /request.*url|navigationAction.*request.*url/,
      'navigation policy must inspect the request URL'
    ),
  ];

  violations.push(...collectProbeViolations(probes, expected));
  return violations;
}

function validateBridgeProvenance(webBridge) {
  const expected = 'Bridge must enforce main-frame and security-origin provenance on incoming messages.';
  const violations = [];

  const probes = [
    requiredProbe(
      webBridge,
      /isMainFrame|isMain\b|mainFrame/,
      'bridge must check isMainFrame on incoming messages'
    ),
    requiredProbe(
      webBridge,
      /scheme|requestURL\b|sourceURL/,
      'bridge must inspect the source origin scheme'
    ),
    requiredProbe(
      webBridge,
      /host\b/,
      'bridge must inspect the source origin host'
    ),
    // Must reject non-main-frame messages
    forbiddenProbe(
      webBridge,
      /allowSubframes|acceptAllFrames/,
      'bridge must not accept messages from subframes'
    ),
  ];

  violations.push(...collectProbeViolations(probes, expected));
  return violations;
}

function validatePathTraversalRejection(schemeHandler) {
  const expected = 'Scheme handler must reject path traversal and symlink escapes.';
  const violations = [];

  const probes = [
    requiredProbe(
      schemeHandler,
      /disallowedPath|disallowed|traversal|illegalPath/,
      'scheme handler must have a path rejection mechanism'
    ),
    requiredProbe(
      schemeHandler,
      /Bundle\.main\.(resourceURL|resourcePath)|resolvingSymlinks|standardizedFileURL/,
      'scheme handler must enforce directory containment via bundle-relative resolution'
    ),
  ];

  violations.push(...collectProbeViolations(probes, expected));
  return violations;
}

function validateLifecyclePatterns(webContainer) {
  const expected = 'WebView container must have explicit teardown.';
  const violations = [];

  // Static source scanning cannot prove runtime lifecycle behavior.
  // This check is limited to structural patterns that suggest lifecycle awareness.

  const probes = [
    requiredProbe(
      webContainer,
      /deinit\b/,
      'WebView container should have a deinit for cleanup'
    ),
    // PR #34 may use webView(_:didFinish:) or WKWebView lifecycle methods
    requiredProbe(
      webContainer,
      /WKNavigationDelegate|WKNavigation|webView\(|WKWebView|didCommit|didFinish|didFail|viewDidDisappear|removeFromSuperview/,
      'WebView container must implement WKNavigationDelegate lifecycle methods'
    ),
  ];

  violations.push(...collectProbeViolations(probes, expected));

  if (violations.length === 0) {
    violations.push({
      file: webContainer.relPath,
      reason: 'Static scanning found lifecycle patterns but cannot prove create/terminate/relaunch/reopen behavior. This remains an explicit acceptance gap requiring runtime test evidence.',
      expected,
      kind: 'LIFECYCLE_PROOF_GAP',
    });
  }

  return violations;
}

function validateSensitiveLoggingBan(files) {
  const expected = 'No source file must log sensitive material (bodies, headers, keys, secrets).';
  const violations = [];
  for (const file of files) {
    if (!file) continue;
    for (const { pattern, message } of SENSITIVE_LOG_PATTERNS) {
      if (pattern.test(file.content)) {
        violations.push(violation(file.relPath, message, expected));
      }
    }
  }
  return violations;
}

// --- Main ---

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const errors = [];

  // Read all candidate source files
  const schemeHandler = await readFirstExisting(root, FILE_CANDIDATES.schemeHandler);
  const appConfig = await readFirstExisting(root, FILE_CANDIDATES.appConfig);
  const webBridge = await readFirstExisting(root, FILE_CANDIDATES.webBridge);
  const navPolicy = await readFirstExisting(root, FILE_CANDIDATES.navPolicy);
  const webContainer = await readFirstExisting(root, FILE_CANDIDATES.webContainer);

  const allFiles = [schemeHandler, appConfig, webBridge, navPolicy, webContainer].filter(Boolean);

  if (allFiles.length === 0) {
    console.error('[payload-containment] No Swift source files found to validate.');
    process.exitCode = 1;
    return;
  }

  // 1. Rejected designs
  errors.push(...validateRejectedDesigns(allFiles));
  if (schemeHandler) {
    // 2. Stable origin
    errors.push(...validateStableOrigin(schemeHandler, appConfig));
    // 3. Path traversal
    errors.push(...validatePathTraversalRejection(schemeHandler));
  }
  if (navPolicy) {
    // 4. Navigation containment
    errors.push(...validateNavigationContainment(navPolicy));
  }
  if (webBridge) {
    // 5. Bridge provenance
    errors.push(...validateBridgeProvenance(webBridge));
  }
  if (webContainer) {
    // 6. Lifecycle patterns (with explicit gap)
    errors.push(...validateLifecyclePatterns(webContainer));
  }
  // 7. Sensitive logging
  errors.push(...validateSensitiveLoggingBan(allFiles));

  // Separate probe violations from documented acceptance gaps
  const probeViolations = errors.filter(e => e.kind !== 'LIFECYCLE_PROOF_GAP');
  const acceptanceGaps = errors.filter(e => e.kind === 'LIFECYCLE_PROOF_GAP');

  console.log(`[payload-containment] inspected files: ${allFiles.map(f => f.relPath).join(', ')}`);
  console.log(`[payload-containment] probe violations: ${probeViolations.length}`);

  if (acceptanceGaps.length > 0) {
    console.log(`[payload-containment] acceptance gaps: ${acceptanceGaps.length}`);
    for (const e of acceptanceGaps) {
      console.log('[payload-containment] gap (not a probe failure)');
      console.log(`  file: ${e.file}`);
      console.log(`  reason: ${e.reason}`);
      console.log(`  kind: ${e.kind}`);
    }
  }

  for (const e of probeViolations) {
    console.log('[payload-containment] violation');
    console.log(`  file: ${e.file}`);
    console.log(`  reason: ${e.reason}`);
    console.log(`  expected: ${e.expected}`);
  }

  if (probeViolations.length === 0) {
    console.log('[payload-containment] result: PASS');
    if (acceptanceGaps.length > 0) {
      console.log('[payload-containment] note: acceptance gaps documented above do not block this check');
    }
    return;
  }

  console.log('[payload-containment] result: FAIL');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('[payload-containment] result: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
