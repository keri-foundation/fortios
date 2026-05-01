import {
    FORTWEB_KF_STATE_SUBDB,
    FORTWEB_REGISTRY_STORE,
    LOADING_FADE_MS,
    VALIDATION_MESSAGE,
    fortwebRegistryWorkerStore,
    fortwebVaultStorageName,
    fortwebVaultWorkerStore,
} from './constants';
import {
    generateId,
    initPyodide,
    installGlobalErrorHooks,
    installNativeCommandHandler,
    isoNow,
    onWorkerLog,
    postToBridge,
    sendToWorker,
} from './keri_runtime';

// Browser-only validation harness. The shipped app loads the staged FortWeb
// product-shell payload through WebPayload/.

const loadingEl = document.getElementById('loading');
const loadingStatusEl = document.getElementById('loading-status');
const appEl = document.getElementById('app');
const statusEl = document.getElementById('status');
const statusDotEl = document.getElementById('status-dot');
const outputEl = document.getElementById('output');

function setStartupStatus(text: string): void {
    if (loadingStatusEl) loadingStatusEl.textContent = text;
}

function showApp(): void {
    if (loadingEl) loadingEl.classList.add('hidden');
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

async function putWorkerValue(store: string, key: string, value: string): Promise<void> {
    const result = await sendToWorker({ id: generateId(), type: 'db_put', store, key, value });
    if (result.type !== 'db_put_result' || !result.ok) {
        throw new Error(result.type === 'error' ? result.error : `unexpected worker result: ${result.type}`);
    }
}

async function getWorkerValue(store: string, key: string): Promise<string | null> {
    const result = await sendToWorker({ id: generateId(), type: 'db_get', store, key });
    if (result.type !== 'db_get_result') {
        throw new Error(result.type === 'error' ? result.error : `unexpected worker result: ${result.type}`);
    }
    return result.value;
}

async function listWorkerValues(store: string, prefix: string): Promise<Array<{ key: string; value: string }>> {
    const result = await sendToWorker({ id: generateId(), type: 'db_list', store, prefix });
    if (result.type !== 'db_list_result') {
        throw new Error(result.type === 'error' ? result.error : `unexpected worker result: ${result.type}`);
    }
    return result.entries;
}

async function deleteWorkerValue(store: string, key: string): Promise<void> {
    const result = await sendToWorker({ id: generateId(), type: 'db_del', store, key });
    if (result.type !== 'db_del_result') {
        throw new Error(result.type === 'error' ? result.error : `unexpected worker result: ${result.type}`);
    }
}

async function runFortwebStorageCheck(): Promise<void> {
    const vaultId = 'validation-alpha';
    const registryStore = fortwebRegistryWorkerStore();
    const vaultStateStore = fortwebVaultWorkerStore(vaultId);
    const createdAt = isoNow();
    const registryValue = JSON.stringify({
        id: vaultId,
        alias: 'Validation Alpha',
        storageName: fortwebVaultStorageName(vaultId),
        runtimeMode: 'pyodide-worker',
        createdAt,
    });
    const stateValue = JSON.stringify({
        status: 'ready',
        vaultId,
        updatedAt: createdAt,
    });

    log(`fortweb storage check: registry=${registryStore} vaultState=${vaultStateStore}`);

    try {
        await putWorkerValue(registryStore, vaultId, registryValue);
        await putWorkerValue(vaultStateStore, 'state', stateValue);

        const registryEntries = await listWorkerValues(registryStore, '');
        const registryEntry = registryEntries.find((entry) => entry.key === vaultId);
        if (!registryEntry || registryEntry.value !== registryValue) {
            throw new Error(`FortWeb registry check failed for ${FORTWEB_REGISTRY_STORE}${vaultId}`);
        }

        const loadedState = await getWorkerValue(vaultStateStore, 'state');
        if (loadedState !== stateValue) {
            throw new Error(`FortWeb vault state check failed for ${FORTWEB_KF_STATE_SUBDB}state`);
        }

        log(`fortweb storage check: registry + ${FORTWEB_KF_STATE_SUBDB} state round-trip ok`);
    } finally {
        await deleteWorkerValue(vaultStateStore, 'state');
        await deleteWorkerValue(registryStore, vaultId);
        log('fortweb storage check: cleaned validation records');
    }
}

async function runCryptoCheck(): Promise<void> {
    const message = VALIDATION_MESSAGE;

    const hashRes = await sendToWorker({ id: generateId(), type: 'blake3_hash', data: message });
    log(`blake3: ${hashRes.type === 'blake3_result' ? hashRes.hex : `(error: ${hashRes.type === 'error' ? hashRes.error : hashRes.type})`}`);

    const signRes = await sendToWorker({ id: generateId(), type: 'sign', message });
    if (signRes.type !== 'sign_result') {
        log(`sign failed: ${signRes.type === 'error' ? signRes.error : signRes.type}`);
        return;
    }

    const { signature, publicKey } = signRes;
    log(`signed ok, pk: ${publicKey.slice(0, 16)}...`);

    const verifyRes = await sendToWorker({ id: generateId(), type: 'verify', message, signature, publicKey });
    log(`pychloride sign+verify: ${verifyRes.type === 'verify_result' ? verifyRes.valid : false}`);
}

async function main(): Promise<void> {
    installGlobalErrorHooks();
    installNativeCommandHandler();
    onWorkerLog(log);
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: 'boot' });

    setStartupStatus('Starting Pyodide runtime...');
    await initPyodide();

    setStartupStatus('Running validation checks...');
    showApp();

    setStatus('running crypto check');
    await runCryptoCheck();

    setStatus('running FortWeb storage check');
    await runFortwebStorageCheck();

    setStatus('validation ready', 'done');
    postToBridge({ type: 'lifecycle', timestamp: isoNow(), message: 'done' });
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    setStatus(message, 'error');
    showApp();
    log(message);
});
