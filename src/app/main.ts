import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/shell.css';
import '../styles/home.css';
import '../styles/vault.css';
import '../styles/settings.css';

import { LOADING_FADE_MS } from '../shared/constants';
import {
    LIFECYCLE_BOOT,
    LIFECYCLE_CRYPTO_READY,
    LIFECYCLE_ERROR,
    LIFECYCLE_PYODIDE_LOADING,
    LIFECYCLE_READY,
} from '../shared/bridge-contract';
import { installIdentifierHandlers } from './identifiers';
import {
    initPyodide,
    installGlobalErrorHooks,
    installNativeCommandHandler,
    isoNow,
    onWorkerLog,
    postToBridge,
} from '../runtime/keri_runtime';
import { runProof } from './proof';
import { installShellHandlers } from './router';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById('loading');
const loadingStatusEl = document.getElementById('loading-status');
const appEl = document.getElementById('app');
const statusEl = document.getElementById('status');
const statusDotEl = document.getElementById('status-dot');
const outputEl = document.getElementById('output');

function setLoadingStatus(text: string): void {
    if (loadingStatusEl) loadingStatusEl.textContent = text;
}

function showApp(): void {
    if (loadingEl) loadingEl.classList.add('hidden');
    // Wait for fade-out transition before showing app
    setTimeout(() => {
        if (loadingEl) loadingEl.style.display = 'none';
        if (appEl) appEl.classList.add('visible');
    }, LOADING_FADE_MS);
}

function setStatus(text: string, state?: 'done' | 'error'): void {
    if (statusEl) statusEl.textContent = text;
    if (statusDotEl) {
        statusDotEl.classList.remove('done', 'error');
        if (state) statusDotEl.classList.add(state);
    }
}

function log(line: string): void {
    if (!outputEl) return;
    outputEl.textContent = `${outputEl.textContent ?? ''}${line}\n`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    installGlobalErrorHooks();
    installNativeCommandHandler();
    onWorkerLog(log);
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: LIFECYCLE_BOOT });

    setLoadingStatus('Loading Pyodide…');
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: LIFECYCLE_PYODIDE_LOADING });
    await initPyodide();
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: LIFECYCLE_CRYPTO_READY });

    setLoadingStatus('Running crypto proof…');
    showApp();
    installShellHandlers();
    installIdentifierHandlers(log);

    setStatus('running proof');
    await runProof(log);

    setStatus('Locksmith shell ready', 'done');
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: LIFECYCLE_READY });

    // Populate build ID from manifest (best-effort, non-blocking)
    fetch('./build-manifest.json')
        .then((r) => r.json())
        .then((m: Record<string, unknown>) => {
            const sha = (m.git_sha as string) ?? (m.dist_tree_sha256 as string);
            const el = document.getElementById('settings-build-id');
            if (el && sha) el.textContent = String(sha).slice(0, 8);
        })
        .catch(() => { /* manifest may not exist in dev */ });
}

main().catch((e: unknown) => {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    setStatus(err, 'error');
    showApp();
    log(err);
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: LIFECYCLE_ERROR });
});
