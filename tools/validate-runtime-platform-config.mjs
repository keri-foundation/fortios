#!/usr/bin/env node

/**
 * Strict structural validator for the iOS runtime-platform configuration.
 *
 * Validates shape, types, allowed values, and field presence. Does NOT
 * evaluate FortWeb requirements compatibility, claim runtime evidence,
 * or generate attestations.
 *
 * Read-only. Returns nonzero on structural violation.
 *
 * Usage:
 *   node tools/validate-runtime-platform-config.mjs [--config <path>]
 *
 * Exit codes:
 *   0 — structurally valid
 *   1 — structural violation
 *   2 — tool error (missing file, unreadable, etc.)
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.resolve(__dirname, '..', 'runtime-platform-config.json');

// --- v1 schema definition ---

const SUPPORTED_SCHEMAS = ['fort.runtime-platform-config.v1'];
const SUPPORTED_VERSIONS = [1];
const ALLOWED_PLATFORMS = ['ios-wkwebview'];
const ALLOWED_REQUIREMENTS_SCHEMAS = ['fort.runtime-requirements.v1'];
const ALLOWED_PROFILES = ['offline-runtime'];

const ALLOWED_ORIGIN_STABILITY = ['fixed-across-launches'];
const ALLOWED_NETWORK_POLICIES = ['deny-all'];
const ALLOWED_ASSET_SOURCES = ['application-bundle'];
const ALLOWED_ASSET_DELIVERIES = ['custom-scheme-handler'];
const ALLOWED_WORKER_FRAMEWORKS = ['wkwebview-javascript'];
const ALLOWED_STORAGE_MECHANISMS = ['webkit-persistent'];
const ALLOWED_STORAGE_PARTITIONS = ['fixed-namespace'];
const ALLOWED_SECURITY_MECHANISMS = ['custom-scheme-tls-like'];
const ALLOWED_BRIDGE_PROVENANCES = ['main-frame-only'];
const ALLOWED_BRIDGE_ORIGIN_VALIDATIONS = ['exact-scheme-host-match'];
const ALLOWED_ENTRYPOINT_SOURCES = ['manifest-declared'];
const ALLOWED_ENTRYPOINT_FALLBACKS = ['none'];

const REQUIRED_TOP_FIELDS = [
    'schema',
    'version',
    'platform',
    'requirements_compatibility',
    'origin',
    'network',
    'assets',
    'workers',
    'storage',
    'security_context',
    'bridge',
    'entrypoint',
];

const KNOWN_TOP_FIELDS = new Set(REQUIRED_TOP_FIELDS);

const KNOWN_ORIGIN_FIELDS = new Set(['scheme', 'host', 'stability']);
const KNOWN_NETWORK_FIELDS = new Set(['policy', 'allowed_schemes']);
const KNOWN_ASSETS_FIELDS = new Set(['source', 'delivery']);
const KNOWN_WORKERS_FIELDS = new Set(['available', 'framework']);
const KNOWN_STORAGE_FIELDS = new Set(['mechanism', 'partition']);
const KNOWN_SECURITY_FIELDS = new Set(['mechanism']);
const KNOWN_BRIDGE_FIELDS = new Set(['provenance', 'origin_validation']);
const KNOWN_ENTRYPOINT_FIELDS = new Set(['source', 'fallback']);
const KNOWN_COMPAT_FIELDS = new Set(['supported_schemas', 'supported_profiles']);

// ---------------------------------------------------------------------------

function fail(message) {
    process.stderr.write(`[validate-runtime-platform-config] ${message}\n`);
    process.exit(1);
}

function toolError(message) {
    process.stderr.write(`[validate-runtime-platform-config] TOOL ERROR: ${message}\n`);
    process.exit(2);
}

function checkStringField(obj, key, label) {
    if (typeof obj[key] !== 'string' || obj[key].trim().length === 0) {
        fail(`${label}.${key} must be a non-empty string, got ${typeof obj[key]}.`);
    }
}

function checkStringEnum(obj, key, allowed, label) {
    if (!allowed.includes(obj[key])) {
        fail(`${label}.${key} must be one of [${allowed.join(', ')}], got '${obj[key]}'.`);
    }
}

function checkBooleanField(obj, key, label) {
    if (typeof obj[key] !== 'boolean') {
        fail(`${label}.${key} must be a boolean, got ${typeof obj[key]}.`);
    }
}

function checkStringArray(obj, key, label) {
    const arr = obj[key];
    if (!Array.isArray(arr)) {
        fail(`${label}.${key} must be an array, got ${typeof arr}.`);
    }
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] !== 'string' || arr[i].trim().length === 0) {
            fail(`${label}.${key}[${i}] must be a non-empty string.`);
        }
        if (seen.has(arr[i])) {
            fail(`${label}.${key} has duplicate entry '${arr[i]}'.`);
        }
        seen.add(arr[i]);
    }
    if (arr.length === 0) {
        fail(`${label}.${key} must not be empty.`);
    }
}

function checkUnknownFields(obj, known, label) {
    for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
            fail(`${label} contains unknown field '${key}'.`);
        }
    }
}

function checkObject(obj, key, label) {
    if (typeof obj[key] !== 'object' || obj[key] === null || Array.isArray(obj[key])) {
        fail(`${label}.${key} must be an object.`);
    }
}

// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    let configPath = DEFAULT_CONFIG;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config' && i + 1 < args.length) {
            configPath = path.resolve(args[++i]);
        }
    }

    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    } catch (err) {
        toolError(`Cannot read config at ${configPath}: ${err.message}`);
    }

    let config;
    try {
        config = JSON.parse(raw);
    } catch (err) {
        fail(`Configuration is not valid JSON: ${err.message}`);
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        fail('Configuration must be a JSON object.');
    }

    // --- Top-level fields ---
    checkUnknownFields(config, KNOWN_TOP_FIELDS, 'root');

    checkStringField(config, 'schema', 'root');
    checkStringEnum(config, 'schema', SUPPORTED_SCHEMAS, 'root');

    if (!Number.isInteger(config.version)) {
        fail(`root.version must be an integer, got ${config.version}.`);
    }
    if (!SUPPORTED_VERSIONS.includes(config.version)) {
        fail(`root.version must be one of [${SUPPORTED_VERSIONS.join(', ')}], got ${config.version}.`);
    }

    checkStringField(config, 'platform', 'root');
    checkStringEnum(config, 'platform', ALLOWED_PLATFORMS, 'root');

    // --- requirements_compatibility ---
    checkObject(config, 'requirements_compatibility', 'root');
    checkUnknownFields(config.requirements_compatibility, KNOWN_COMPAT_FIELDS, 'root.requirements_compatibility');
    checkStringArray(config.requirements_compatibility, 'supported_schemas', 'root.requirements_compatibility');
    for (const s of config.requirements_compatibility.supported_schemas) {
        if (!ALLOWED_REQUIREMENTS_SCHEMAS.includes(s)) {
            fail(`root.requirements_compatibility.supported_schemas contains unsupported schema '${s}'.`);
        }
    }
    checkStringArray(config.requirements_compatibility, 'supported_profiles', 'root.requirements_compatibility');
    for (const p of config.requirements_compatibility.supported_profiles) {
        if (!ALLOWED_PROFILES.includes(p)) {
            fail(`root.requirements_compatibility.supported_profiles contains unsupported profile '${p}'.`);
        }
    }

    // --- origin ---
    checkObject(config, 'origin', 'root');
    checkUnknownFields(config.origin, KNOWN_ORIGIN_FIELDS, 'root.origin');
    checkStringField(config.origin, 'scheme', 'root.origin');
    checkStringField(config.origin, 'host', 'root.origin');
    checkStringField(config.origin, 'stability', 'root.origin');
    checkStringEnum(config.origin, 'stability', ALLOWED_ORIGIN_STABILITY, 'root.origin');

    // --- network ---
    checkObject(config, 'network', 'root');
    checkUnknownFields(config.network, KNOWN_NETWORK_FIELDS, 'root.network');
    checkStringField(config.network, 'policy', 'root.network');
    checkStringEnum(config.network, 'policy', ALLOWED_NETWORK_POLICIES, 'root.network');
    checkStringArray(config.network, 'allowed_schemes', 'root.network');

    // --- assets ---
    checkObject(config, 'assets', 'root');
    checkUnknownFields(config.assets, KNOWN_ASSETS_FIELDS, 'root.assets');
    checkStringField(config.assets, 'source', 'root.assets');
    checkStringEnum(config.assets, 'source', ALLOWED_ASSET_SOURCES, 'root.assets');
    checkStringField(config.assets, 'delivery', 'root.assets');
    checkStringEnum(config.assets, 'delivery', ALLOWED_ASSET_DELIVERIES, 'root.assets');

    // --- workers ---
    checkObject(config, 'workers', 'root');
    checkUnknownFields(config.workers, KNOWN_WORKERS_FIELDS, 'root.workers');
    checkBooleanField(config.workers, 'available', 'root.workers');
    checkStringField(config.workers, 'framework', 'root.workers');
    checkStringEnum(config.workers, 'framework', ALLOWED_WORKER_FRAMEWORKS, 'root.workers');

    // --- storage ---
    checkObject(config, 'storage', 'root');
    checkUnknownFields(config.storage, KNOWN_STORAGE_FIELDS, 'root.storage');
    checkStringField(config.storage, 'mechanism', 'root.storage');
    checkStringEnum(config.storage, 'mechanism', ALLOWED_STORAGE_MECHANISMS, 'root.storage');
    checkStringField(config.storage, 'partition', 'root.storage');
    checkStringEnum(config.storage, 'partition', ALLOWED_STORAGE_PARTITIONS, 'root.storage');

    // --- security_context ---
    checkObject(config, 'security_context', 'root');
    checkUnknownFields(config.security_context, KNOWN_SECURITY_FIELDS, 'root.security_context');
    checkStringField(config.security_context, 'mechanism', 'root.security_context');
    checkStringEnum(config.security_context, 'mechanism', ALLOWED_SECURITY_MECHANISMS, 'root.security_context');

    // --- bridge ---
    checkObject(config, 'bridge', 'root');
    checkUnknownFields(config.bridge, KNOWN_BRIDGE_FIELDS, 'root.bridge');
    checkStringField(config.bridge, 'provenance', 'root.bridge');
    checkStringEnum(config.bridge, 'provenance', ALLOWED_BRIDGE_PROVENANCES, 'root.bridge');
    checkStringField(config.bridge, 'origin_validation', 'root.bridge');
    checkStringEnum(config.bridge, 'origin_validation', ALLOWED_BRIDGE_ORIGIN_VALIDATIONS, 'root.bridge');

    // --- entrypoint ---
    checkObject(config, 'entrypoint', 'root');
    checkUnknownFields(config.entrypoint, KNOWN_ENTRYPOINT_FIELDS, 'root.entrypoint');
    checkStringField(config.entrypoint, 'source', 'root.entrypoint');
    checkStringEnum(config.entrypoint, 'source', ALLOWED_ENTRYPOINT_SOURCES, 'root.entrypoint');
    checkStringField(config.entrypoint, 'fallback', 'root.entrypoint');
    checkStringEnum(config.entrypoint, 'fallback', ALLOWED_ENTRYPOINT_FALLBACKS, 'root.entrypoint');

    // Success
    process.stdout.write(`[validate-runtime-platform-config] Structurally valid: ${configPath}\n`);
}

await main();
