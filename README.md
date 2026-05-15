# Fort-ios

**Fort-ios** is the KERI Foundation iOS wallet host repo. It contains a thin native wrapper plus a browser-only validation harness used for local bridge and worker checks:

| Layer | What it is | Where it lives |
|-------|-----------|----------------|
| **Browser validation harness** | Local Vite + TypeScript surface used to validate the bridge, Pyodide runtime, and FortWeb storage compatibility | `src/`, `public/`, `vite.config.ts` |
| **iOS wrapper** | UIKit app with a `WKWebView` that serves the web payload via a custom `app://` scheme handler | `xcodeproj/`, `KeriWallet/` |

The two layers communicate through a typed JS↔Swift bridge (`bridge-contract.json`). The web payload is bundled at build time and served entirely from the app bundle — no network fetches at runtime.

The wrapper ships a single payload source:

| Payload source | Status | How to stage it |
|-------|--------|----------------|
| `fortweb` | Required wrapper payload posture for upstream Fort-ios | `make sync` or `make sync-fortweb` |

The browser validation harness is non-shipped. The app bundle must stage and serve the FortWeb product-shell payload from `WebPayload/`.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-time setup](#2-first-time-setup)
3. [Daily workflow](#3-daily-workflow)
4. [Make targets reference](#4-make-targets-reference)
5. [npm scripts reference](#5-npm-scripts-reference)
6. [How the sync pipeline works](#6-how-the-sync-pipeline-works)
7. [Testing](#7-testing)
8. [Bridge contract](#8-bridge-contract)
9. [Repository layout](#9-repository-layout)
10. [Documentation index](#10-documentation-index)
11. [App Store compliance](#11-app-store-compliance)

---

## 1. Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **mise** | latest | `curl https://mise.run \| sh` |
| **Node** | 22.12.0 | managed automatically by mise via `.tool-versions` |
| **Xcode** | 16.x | Mac App Store |
| **SwiftLint** | latest | `brew install swiftlint` |

> mise manages the Node version — you do not need to install Node manually.

### Python version constraint (Pyodide)

Pyodide currently ships Python **3.13**. Any Python code loaded in the web payload
(via `runPythonAsync`) must be compatible with 3.13 — do not use Python 3.14-only
features until Pyodide releases a 3.14 build. This applies regardless of what
keripy uses on the server side. See the 2026-02-24 KERI Foundation dev meeting
(workspace docs) for Sam's directive on this constraint.

---

## 2. First-time setup

Run these commands once after cloning. Order matters.

```sh
# 1. Install and activate the pinned Node version
curl https://mise.run | sh   # skip if mise is already installed
mise install                  # reads .tool-versions → installs Node 22.12.0

# 2. Install Node dependencies (uses lockfile — do NOT use npm install)
npm ci

# 3. Download Pyodide runtime + crypto wheels into public/pyodide/
#    (~200 MB, gitignored, only needed once per machine)
make pyodide
```

After these three steps the project is ready to build.

---

## 3. Daily workflow

```sh
# 1. Confirm Xcode, Simulator, and payload-source readiness
make ios-doctor

# 2. Stage the shipped wrapper payload and verify the payload contract
make sync                       # default: FortWeb convergence path
make sync-fortweb              # explicit alias for the same FortWeb path
make payload-contract

# Optional: stage a deterministic FortWeb ref instead of mutable local ../fortweb
PAYLOAD_SOURCE=fortweb FORTWEB_FETCH=1 FORTWEB_REF=214643f4fa907061334c09c8297c4d1e59f18f45 make payload-contract

# 3. Run the fast local checks
make lint                      # SwiftLint (Swift sources)
make lint-ts                   # tsc --noEmit (TypeScript)
make test-ts                   # Vitest unit tests

# 4. Build and launch on Simulator
make dev-sim
make run-sim

# 5. Build and launch on physical device
make dev-device
make run-device DEVICE_REF=<udid-or-name>

# 6. Optional wrapper/device parity checks
make parity-smoke DEVICE_REF=<udid-or-name>
make logs-sim
make logs-device DEVICE_REF=<udid-or-name>
```

### Known-good baseline

For review and debug runs, use deterministic FortWeb ref staging and treat [KNOWN-GOOD-IOS-BASELINE.md](KNOWN-GOOD-IOS-BASELINE.md) as the source of truth for the current known-good tuple.

```sh
PAYLOAD_SOURCE=fortweb FORTWEB_FETCH=1 FORTWEB_REF=214643f4fa907061334c09c8297c4d1e59f18f45 make payload-contract
```

Do not use dirty local FortWeb HEAD or hand-edited `WebPayload/` as review evidence.

For conference acceptance and simulator/device parity runs, use [CONFERENCE-IOS-VALIDATION-CHECKLIST.md](CONFERENCE-IOS-VALIDATION-CHECKLIST.md).

Run `make help` at any time to list all available targets.

---

## 4. Make targets reference

| Target | What it does |
|--------|-------------|
| `make help` | List all targets with descriptions |
| `make setup` | Install Node dependencies (`npm ci`) |
| `make pyodide` | Download Pyodide v0.29.1 runtime + crypto wheels into `public/pyodide/` |
| `make sync` | Stage the FortWeb product-shell payload into `WebPayload/` |
| `make sync-fortweb` | Explicit alias for the FortWeb wrapper staging path |
| `make payload-contract` | Scan active sources for blocked legacy payload posture and validate the staged `WebPayload/` manifest |
| `make ios-list-sims` | List available iOS Simulator destinations |
| `make ios-list-devices` | List CoreDevice-visible physical devices |
| `make ios-doctor` | Verify Xcode, simulator, and payload-source readiness |
| `make dev-sim` | Sync payload, run TS checks, and build for Simulator |
| `make run-sim` | Boot, install, and launch on the configured Simulator |
| `make dev-device` | Sync payload and build for a generic iOS device output |
| `make run-device DEVICE_REF=<udid-or-name>` | Install and launch on a physical device |
| `make parity-smoke DEVICE_REF=<udid-or-name>` | Run the shared payload sequentially on simulator and device |
| `make logs-sim` | Show recent simulator logs for `KeriWallet` |
| `make logs-device DEVICE_REF=<udid-or-name>` | Relaunch on device with the console attached |
| `make build` | `xcodebuild` — build KeriWallet for iOS Simulator (Debug) |
| `make open` | Open `KeriWallet.xcodeproj` in Xcode |
| `make lint` | Run SwiftLint with `--strict` on all Swift sources |
| `make lint-ts` | Run `tsc --noEmit` to type-check TypeScript without emitting |
| `make test-swift` | Run Swift unit + UI tests on iOS Simulator via `xcodebuild test` |
| `make test-ts` | Run Vitest unit tests (`vitest run`) |
| `make test-e2e` | Run Playwright structural tests (excludes `@slow` Pyodide runtime tests) |
| `make test-e2e-slow` | Run all Playwright tests including the 120 s Pyodide roundtrip |
| `make test-all` | Run `test-swift` + `test-ts` + `test-e2e` in sequence |
| `make bridge-check` | Verify `bridge-contract.ts` and `BridgeContract.swift` match `bridge-contract.json` |
| `make clean` | Remove `build/DerivedData`, `test-results/`, and `dist/` |

---

## 5. npm scripts reference

These are invoked internally by `make` targets. Use `make` for day-to-day work.

| Script | Command | Notes |
|--------|---------|-------|
| `npm run dev` | `vite` | Local dev server. iOS wrapper always loads bundled assets — not used in app. |
| `npm run build` | `vite build` (+ pre-build contract generation) | Browser validation harness build. |
| `npm run build:ci` | contract gen → `vite build` → manifest gen | Deterministic browser validation harness build. Writes `dist/build-manifest.json`. |
| `npm run bridge:check` | `gen-bridge-contract.mjs` then `git diff --exit-code -- src/bridge-contract.ts xcodeproj/KeriWallet/KeriWallet/BridgeContract.swift` | Regenerates bridge bindings, then fails if the generated TypeScript or Swift bridge files drift from the committed state. |
| `npm run typecheck` | `tsc --noEmit` | TypeScript type checking only, no output files. |
| `npm run test` | `vitest run` | Single-pass unit test run. |
| `npm run test:watch` | `vitest` | Watch mode for local development. |
| `npm run test:e2e` | `playwright test` | Playwright browser tests. |

---

## 6. How the sync pipeline works

The web payload cannot be hot-reloaded in the iOS Simulator — assets must live inside the app bundle. The sync pipeline automates this:

```
FortWeb app/vendor/wheels  →  sync-payload.sh  →  WebPayload/
                                               ↓
                                     Xcode bundles WebPayload/
                                     into the .app at build time
```

The pipeline is split into two scripts:

**`build-payload.sh`** (browser-only validation harness build):

1. Runs `npm ci && npm run build:ci` to produce a deterministic `dist/`.
2. Verifies `dist/build-manifest.json` exists and has the required fields.

**`sync-payload.sh`** (iOS-specific, invoked by `make sync`) stages the live wrapper payload:

1. Copies the FortWeb app, vendor, wheels, and runtime config into `WebPayload/fortweb/`.
2. Writes a root redirect page for the native host.
3. Writes a FortWeb product-shell build manifest.
4. Validates the staged payload contract before returning.

For deterministic staging, set `FORTWEB_FETCH=1` and `FORTWEB_REF=<commit-or-tag-or-branch>` so the script fetches a temporary FortWeb checkout instead of consuming mutable local `../fortweb` state.

> **Rule:** Always run the appropriate sync target after changing payload source files. Never manually edit `WebPayload/`.

### Determinism contract

- `dist/` is build output → **must not be committed**.
- Toolchain is pinned via `.tool-versions` (mise) + `package-lock.json`.
- The canonical build command is `npm ci && npm run build:ci`.
- `dist/build-manifest.json` records: git SHA, lockfile hash, `dist/` content hash, Node/npm versions.

---

## 7. Testing

Fort-ios uses a three-layer test pyramid. See ADR-030 in the workspace docs for the full rationale.

### Layer 1 — Swift unit tests (swift-testing)

Tests for Swift policy objects: `PayloadSchemeHandlerTests`, `AppConfigTests`, `WebBridgeTests`.

```sh
make test-swift
# or:
xcodebuild test \
  -project xcodeproj/KeriWallet/KeriWallet.xcodeproj \
  -scheme KeriWallet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

The test targets use Swift 5.9 (`@Suite`, `@Test`, `#expect`, `#require`). The app target stays at Swift 5.0. New `.swift` files dropped into `KeriWalletTests/` are auto-included by Xcode 16's `PBXFileSystemSynchronizedRootGroup` — no `project.pbxproj` edits needed.

### Layer 2 — TypeScript unit tests (Vitest)

Tests for `worker_router.ts` dispatch logic and constant contracts. These run in a Node environment with no browser or WASM required.

```sh
make test-ts           # single pass (~100 ms)
npm run test:watch     # watch mode
```

Files: `src/__tests__/worker_router.test.ts` (12 tests), `src/__tests__/constants.test.ts` (12 tests).

### Layer 3 — Playwright E2E tests

Structural browser tests that load the local validation harness in Chromium headless and assert DOM invariants, JS error absence, and bridge contract alignment. They are useful for bridge and worker confidence, but they are not end-to-end confirmation that the FortWeb-hosted product path is green. The Pyodide roundtrip test is tagged `@slow` (120 s) and excluded from the default CI run.

```sh
make test-e2e          # structural tests only (~5 s)
make test-e2e-slow     # includes Pyodide runtime roundtrip (~120 s)
```

Files: `playwright/app.spec.ts`.

For the native wrapper itself, use `make logs-sim`, `make logs-device`, or Console.app to inspect the retained host-side breadcrumbs around initial payload load, first bridge receipt, blocked navigation, and scheme-handler failures.

### Run everything

```sh
make test-all   # test-swift + test-ts + test-e2e
```

---

## 8. Bridge contract

The JS↔native bridge is governed by a typed contract so all sides stay in sync.

- **Source of truth:** `bridge-contract.json` (committed)
- **Generated:** `src/bridge-contract.ts` (TypeScript), `KeriWallet/BridgeContract.swift` (Swift), and `generated/BridgeContract.kt` (Kotlin for Fort-android, generated locally when needed)
- **Verify sync:** `make bridge-check` regenerates all outputs, then fails if the tracked TypeScript or Swift contract files drift from committed JSON

The `prebuild` npm hook regenerates all contract outputs automatically before every build. In CI, `make bridge-check` must pass before tests run.

Message envelope shape (JS → Swift):

```json
{ "type": "lifecycle | js_error | log | crypto_result | unhandled_rejection", "timestamp": "<ISO 8601>", ... }
```

---

## 9. Repository layout

```
Fort-ios/
├── src/                        # TypeScript source
│   ├── main.ts                 # Browser-only validation harness entry point
│   ├── bridge_adapter.ts       # Platform-agnostic bridge transport (iOS/Android/no-op)
│   ├── pyodide_worker.ts       # Web Worker — WASM bootstrap lifecycle
│   ├── worker_router.ts        # Pure message dispatch (testable without WASM)
│   ├── bridge-contract.ts      # Generated — do not edit by hand
│   └── __tests__/              # Vitest unit tests
├── generated/
│   └── BridgeContract.kt       # Generated Kotlin constants (for Fort-android, not committed)
├── public/
│   └── pyodide/                # Gitignored — populated by `make pyodide`
├── playwright/
│   └── app.spec.ts             # Playwright E2E tests
├── tools/
│   ├── gen-bridge-contract.mjs # Generates bridge-contract.ts + BridgeContract.swift + BridgeContract.kt
│   └── gen-build-manifest.mjs  # Generates dist/build-manifest.json
├── scripts/
│   └── download-pyodide.sh     # Downloads Pyodide runtime + wheels
├── KeriWallet/                 # Swift source (symlinks into xcodeproj/)
│   ├── AppDelegate.swift
│   ├── AppLogger.swift         # OSLog-backed structured logging
│   ├── AppConfig.swift         # App-wide constants (schemes, limits, headers)
│   ├── BridgeContract.swift    # Generated — do not edit by hand
│   ├── PayloadSchemeHandler.swift  # WKURLSchemeHandler serving WebPayload/
│   ├── WebBridge.swift         # WKScriptMessageHandler — decodes bridge envelopes
│   ├── WebContainerViewController.swift
│   ├── WebNavigationPolicy.swift   # Deny-by-default navigation allowlist
│   └── PrivacyInfo.xcprivacy
├── KeriWalletTests/            # Swift unit tests (swift-testing)
├── KeriWalletUITests/          # Swift UI smoke test
├── xcodeproj/                  # Xcode project + mirrored Swift source
│   └── KeriWallet/
│       ├── KeriWallet/         # Mirror of KeriWallet/ above (symlinked)
│       └── KeriWallet.xcodeproj
├── WebPayload/                 # Synced dist/ output — Xcode bundles this
├── WebPayloadOverride/         # Debug-only local override (NOT YET IMPLEMENTED)
├── Config/
│   ├── Debug.xcconfig
│   └── Release.xcconfig
├── bridge-contract.json        # Source of truth for the JS↔native bridge
├── build-payload.sh            # Platform-agnostic build core (sourced by sync scripts)
├── sync-payload.sh             # iOS-specific payload sync (invoked by `make sync`)
├── Makefile                    # All developer commands — start here
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── tsconfig.json
└── .tool-versions              # Pins Node 22.12.0 via mise
```

> **Swift source symlinks:** `KeriWallet/*.swift` are symlinks into `xcodeproj/KeriWallet/KeriWallet/`. Edit either location — they are the same file. When adding a new Swift file, create it inside `xcodeproj/…/KeriWallet/`, then add a symlink: `ln -s ../xcodeproj/KeriWallet/KeriWallet/NewFile.swift KeriWallet/NewFile.swift`.

---

## 10. Documentation index

### Workspace Architecture Decision Records

| ADR | Title | Summary |
|-----|-------|---------|
| [ADR-022](docs/adr/ADR-022-ios-wkwebview-pyodide-bundled-payload.md) | Bundled payload decision | Why all assets are bundled at build time (no runtime download) |
| [ADR-023](docs/adr/ADR-023-ios-wrapper-architecture.md) | iOS wrapper architecture | UIKit + WKWebView + custom scheme handler design |
| [ADR-024](docs/adr/ADR-024-web-payload-build-bundling.md) | Web payload build & bundling | Deterministic build, `sync-payload.sh`, and bundle staging |
| [ADR-025](docs/adr/ADR-025-ios-build-ci-developer-workflow.md) | iOS build/CI & developer workflow | VS Code + `xcodebuild` golden path, CI recipe |
| [ADR-026](docs/adr/ADR-026-ios-logging-strategy.md) | iOS logging strategy | `AppLogger`, privacy-aware OSLog usage |
| [ADR-031](docs/adr/ADR-031-cross-platform-shared-web-payload.md) | Cross-platform shared web payload | Thin native wrappers around one shared web payload |
| [ADR-051](docs/adr/ADR-051-android-native-wrapper-thin-webview-host.md) | Android thin host | Current Android wrapper posture aligned with the iOS thin-host goal |

### Workspace instructions

These files live in the keri-notes workspace, not in this repo.

| File | Covers |
|------|--------|
| `.github/instructions/ios-swift-coding.instructions.md` | Swift style, naming, DI patterns, testing with swift-testing |
| `.github/instructions/ios-xcode-workflow.instructions.md` | Xcode build/CI workflow, anti-patterns catalog, `xcodebuild` reference |
| `.github/instructions/ios-wkwebview-pyodide-bundled-payload.instructions.md` | WKWebView rules, scheme handler, worker architecture, telemetry bridge |
| `.github/instructions/pyodide-config.instructions.md` | Pyodide version, wheel sources, `unpackArchive` install pattern |
| `.github/instructions/pyodide-event-loop.instructions.md` | Asyncio event loop inside Pyodide WASM |
| `.github/instructions/pyodide-js-bridge.instructions.md` | Python↔JavaScript data passing via Pyodide proxy objects |

### Conference validation

| File | Purpose |
|------|---------|
| [KNOWN-GOOD-IOS-BASELINE.md](KNOWN-GOOD-IOS-BASELINE.md) | Frozen Fort-ios wrapper + payload + simulator tuple for regression restore and reviewable evidence |
| [CONFERENCE-IOS-VALIDATION-CHECKLIST.md](CONFERENCE-IOS-VALIDATION-CHECKLIST.md) | End-to-end simulator and physical-device validation script for conference acceptance |

---

## 11. App Store compliance

Two issues arise from the bundled Pyodide payload. Both are handled automatically.

### `itms-services` string in `python_stdlib.zip`

`urllib/parse.py` inside the bundled `python_stdlib.zip` contains the string `itms-services`, which triggers Apple's automated binary scanner and causes App Store rejection. `sync-payload.sh` patches this during sync by replacing `itms-services` → `itms_services` in the zip in place.

To verify the patch was applied:

```sh
python3 -c "
import zipfile
z = zipfile.ZipFile('WebPayload/pyodide/python_stdlib.zip')
content = z.read('lib/python3.13/urllib/parse.py').decode()
print('patched:', 'itms-services' not in content)
"
# Should print: patched: True
```

### Privacy manifest

`KeriWallet/PrivacyInfo.xcprivacy` declares the Required Reason APIs used by the wrapper. Keep this up to date when adding new APIs. The first TestFlight upload will surface any missing declarations.

### Reviewer notes (include with every submission)

> The app runs a bundled, immutable WebAssembly payload. No executable code is downloaded at runtime. Navigation is locked to the `app://` custom scheme — this is not a browser.
