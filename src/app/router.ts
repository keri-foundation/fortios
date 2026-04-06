// ── router.ts ─────────────────────────────────────────────────────────────────
//
// Shell routing: tab bar navigation, vault pill sub-navigation, and screen
// transitions.  Extracted from main.ts to isolate UI navigation from boot
// orchestration and feature logic.

import { ICON_HOME, ICON_LOCK, ICON_SETTINGS, ICON_VAULT } from './icons';

export type RouteName = 'home' | 'vault' | 'settings';
export type VaultPageName = 'identifiers' | 'remotes' | 'groups' | 'credentials' | 'notifications';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const homeScreenEl = document.getElementById('home-screen');
const vaultScreenEl = document.getElementById('vault-screen');
const settingsScreenEl = document.getElementById('settings-screen');

const tabHomeEl = document.getElementById('tab-home');
const tabVaultEl = document.getElementById('tab-vault');
const tabSettingsEl = document.getElementById('tab-settings');

const btnOpenVaultEl = document.getElementById('btn-open-vault');
const btnLockVaultEl = document.getElementById('btn-lock-vault');
const btnLockWalletEl = document.getElementById('btn-lock-wallet');

const vaultNavButtons = Array.from(document.querySelectorAll<HTMLElement>('.vault-pill[data-vault-nav]'));
const vaultPages = Array.from(document.querySelectorAll<HTMLElement>('[data-vault-page]'));

// ── State ─────────────────────────────────────────────────────────────────────
const shellState: { route: RouteName; vaultPage: VaultPageName } = {
    route: 'home',
    vaultPage: 'identifiers',
};

// ── Route management ──────────────────────────────────────────────────────────
export function setRoute(route: RouteName): void {
    shellState.route = route;

    homeScreenEl?.classList.toggle('active', route === 'home');
    vaultScreenEl?.classList.toggle('active', route === 'vault');
    settingsScreenEl?.classList.toggle('active', route === 'settings');

    const tabs = [
        { el: tabHomeEl, name: 'home' as RouteName },
        { el: tabVaultEl, name: 'vault' as RouteName },
        { el: tabSettingsEl, name: 'settings' as RouteName },
    ];
    for (const tab of tabs) {
        const isActive = tab.name === route;
        tab.el?.classList.toggle('active', isActive);
        tab.el?.setAttribute('aria-selected', String(isActive));
    }
}

export function setVaultPage(page: VaultPageName): void {
    shellState.vaultPage = page;
    for (const button of vaultNavButtons) {
        button.classList.toggle('active', button.dataset.vaultNav === page);
    }
    for (const pageEl of vaultPages) {
        pageEl.classList.toggle('active', pageEl.dataset.vaultPage === page);
    }
}

export function openVault(page: VaultPageName = 'identifiers'): void {
    setRoute('vault');
    setVaultPage(page);
}

// ── Shell setup ───────────────────────────────────────────────────────────────
function injectIcons(): void {
    if (tabHomeEl) tabHomeEl.innerHTML = `${ICON_HOME}<span>Home</span>`;
    if (tabVaultEl) tabVaultEl.innerHTML = `${ICON_VAULT}<span>Vault</span>`;
    if (tabSettingsEl) tabSettingsEl.innerHTML = `${ICON_SETTINGS}<span>Settings</span>`;
    if (btnLockVaultEl) btnLockVaultEl.innerHTML = ICON_LOCK;
}

export function installShellHandlers(): void {
    injectIcons();

    // Tab bar navigation
    tabHomeEl?.addEventListener('click', () => setRoute('home'));
    tabVaultEl?.addEventListener('click', () => openVault(shellState.vaultPage));
    tabSettingsEl?.addEventListener('click', () => setRoute('settings'));

    // Home → Open Vault shortcut
    btnOpenVaultEl?.addEventListener('click', () => openVault('identifiers'));

    // Vault lock (header ghost button) → back to home
    btnLockVaultEl?.addEventListener('click', () => setRoute('home'));

    // Settings → Lock Wallet → back to home
    btnLockWalletEl?.addEventListener('click', () => setRoute('home'));

    // Vault pill sub-navigation
    for (const button of vaultNavButtons) {
        button.addEventListener('click', () => {
            const page = button.dataset.vaultNav as VaultPageName | undefined;
            if (!page) return;
            openVault(page);
        });
    }

    // Appearance theme switcher
    initAppearance();

    setRoute('home');
    setVaultPage('identifiers');
}

// ── Appearance (theme) ─────────────────────────────────────────────────────────
const THEME_KEY = 'keri-appearance';
type ThemeChoice = 'system' | 'light' | 'dark';

const systemMQ = matchMedia('(prefers-color-scheme: light)');

function applyTheme(choice: ThemeChoice): void {
    const isLight =
        choice === 'light' || (choice === 'system' && systemMQ.matches);
    document.documentElement.classList.toggle('theme-light', isLight);
    document.documentElement.classList.toggle('theme-dark', !isLight);
}

function initAppearance(): void {
    const selectEl = document.getElementById('select-appearance') as HTMLSelectElement | null;
    if (!selectEl) return;

    const saved = (localStorage.getItem(THEME_KEY) ?? 'system') as ThemeChoice;
    selectEl.value = saved;
    applyTheme(saved);

    // Re-evaluate when OS theme changes (only matters in system mode)
    systemMQ.addEventListener('change', () => {
        const current = (localStorage.getItem(THEME_KEY) ?? 'system') as ThemeChoice;
        if (current === 'system') applyTheme('system');
    });

    selectEl.addEventListener('change', () => {
        const choice = selectEl.value as ThemeChoice;
        localStorage.setItem(THEME_KEY, choice);
        applyTheme(choice);
    });
}
