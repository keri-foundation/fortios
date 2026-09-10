import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Node environment — all tool tests run without a DOM/browser.
        environment: 'node',
        // No implicit globals (describe/it/expect) — use explicit imports from vitest.
        globals: false,
        include: ['tools/__tests__/**/*.test.mjs'],
    },
});
