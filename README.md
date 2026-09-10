# Fort-ios

**Fort-ios** is the KERI Foundation iOS wallet host repo. It is a thin native wrapper: a UIKit app with a `WKWebView` that serves the **canonical FortWeb offline runtime** via a custom `app://` scheme handler.

| Layer | What it is | Where it lives |
|-------|-----------|----------------|
| **iOS native host** | UIKit + `WKWebView`, custom `app://` payload scheme handler, deny-by-default navigation allowlist, typed JS↔native bridge | `KeriWallet/`, `KeriWallet.xcodeproj` |
| **Node tooling** | Payload import/validation and bridge-contract generation used by `make` and CI | `tools/` |

There is no in-repo browser/JS build. The web payload is the canonical FortWeb runtime package produced by FortWeb's own `package:runtime` tooling from a pinned, reviewed runtime source (see `libs/fortweb/docs/runtime-package-contract.md`). Fort-ios imports that ZIP into `WebPayload/` (`make payload-import`), validates it, and bundles it at build time. No network fetches occur at runtime.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-time setup](#2-first-time-setup)
3. [Daily workflow](#3-daily-workflow)
4. [Make targets reference](#4-make-targets-reference)
5. [npm scripts reference](#5-npm-scripts-reference)
6. [How the payload import pipeline works](#6-how-the-payload-import-pipeline-works)
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
| **SwiftLint** | latest | `brew install swiftlint` |

### Xcode version policy

Hosted CI runs the `swift-tests` job with
`DEVELOPER_DIR=/Applications/Xcode_26.5.app/Contents/Developer` and resolves an `iPhone 17 Pro`
simulator on iOS 26.5. The latest manual verification build ran Xcode 26.6 against an iOS 26.5
simulator.

The deployment target remains **iOS 16.4** and is independent of the installed
simulator runtime. Older Xcode compatibility has not been revalidated against
the current project format.

| Attribute | Value |
|-----------|-------|
| Minimum supported Xcode | Not verified; last validated with 26.4.1 |
| Currently verified Xcode | 26.5 in CI, 26.6 for the manual verification build |
| Currently verified iOS SDK | 26.5 |
| Deployment target | 16.4 |
| Currently verified simulator runtime | 26.5 |
| Swift language mode | 5 |
| Project object version | 77 |

> mise manages the Node version — you do not need to install Node manually.

### Python runtime (bundled FortWeb payload)

The Python interpreter and KERI runtime shipped inside the app are determined by
the canonical FortWeb runtime package. Fort-ios does not build or vendor Python
itself; the pinned package manifest is validated before bundling.

The payload this repository currently bundles comes from FortWeb release asset
`runtime-source-pyodide-314-20260909`, built from FortWeb branch `pyodide-314-runtime` at
`bdb81afa7593603141e8db306f0636a583d2db02`. That commit is the mobile-tested runtime source.
FortWeb PR #38 has since advanced to `de66af9` with a newer runtime source that no mobile wrapper
has consumed, so do not treat the #38 head as the tested artifact. See
`libs/fortweb/docs/runtime-package-contract.md` for the producer contract, and
`keri-notes/docs/architecture/mobile-runtime-compatibility.md` for the canonical compatibility
matrix.

---

## 2. First-time setup

Run these commands once after cloning. Order matters.

```sh
# 1. Install and activate the pinned Node version
curl https://mise.run | sh   # skip if mise is already installed
mise install                  # reads .tool-versions → installs Node 22.12.0

# 2. Install Node tooling dependencies (uses lockfile — do NOT use npm install)
npm ci

# 3. (One-time) Import the canonical FortWeb runtime package into WebPayload/
#    FORTWEB_DIR must be a FortWeb #38 checkout with the reviewed runtime source
#    acquired and dist/runtime built (see section 6).
make payload-contract FORTWEB_DIR=~/Projects/fortweb-f38
```

After these three steps the project is ready to build.

---

## 3. Daily workflow

### Quick start — prepare for Xcode

```sh
# One command to prepare the repo for opening in Xcode:
make xcode-ready FORTWEB_DIR=<FortWeb #38 checkout>

# Then open Xcode and press Play.
make open
```

This resolves a simulator, imports the canonical FortWeb runtime package when
`WebPayload/` is absent, validates the payload contract, and checks the bridge
contract. Use `make xcode-ready XCODE_READY_TESTS=0` to skip the Node tool tests.

### Simulator selection

The Makefile auto-resolves a single iPhone simulator:

```
# Auto-detect (single booted → newest runtime → preferred model):
make build

# Override by name:
make build SIMULATOR_NAME="iPhone 16"

# Override by name + OS version:
make build SIMULATOR_NAME="iPhone 17 Pro" SIMULATOR_OS=26.4.1

# Override by UDID:
make build SIMULATOR_UDID="11111111-1111-1111-1111-111111111111"

# See what was resolved:
make ios-resolve-sim
```

### Full workflow

```sh
# 1. Confirm repo readiness
make ios-doctor

# 2. Simulator info
make ios-resolve-sim

# 3. Import the canonical FortWeb runtime package and verify the payload contract
make payload-contract FORTWEB_DIR=<FortWeb #38 checkout>

# 4. Run the fast local checks
make lint                      # SwiftLint (Swift sources)
make test-tools                # Node tool tests (Vitest)

# 5. Build and launch on Simulator
make build
make run-sim

# 6. Build and launch on physical device
make dev-device
make run-device DEVICE_REF=<udid-or-name>

# 7. Optional wrapper/device parity checks
make parity-smoke DEVICE_REF=<udid-or-name>
make logs-sim
make logs-device DEVICE_REF=<udid-or-name>
```

For release evidence, use [docs/app-store-submission-checklist.md](docs/app-store-submission-checklist.md). For simulator/device parity runs, use `make parity-smoke DEVICE_REF=<udid-or-name>`.

Run `make help` at any time to list all available targets.

---

## 4. Make targets reference

| Target | What it does |
|--------|-------------|
| `make help` | List all targets with descriptions |
| `make setup` | Install Node tooling dependencies (`npm ci`) |
| `make payload-package` | Produce the canonical FortWeb runtime package via FortWeb's `package:runtime` |
| `make payload-import` | Import the canonical `fortweb-runtime-*.zip` into `WebPayload/` |
| `make payload-contract` | Import + run the full validation suite on the staged `WebPayload/` |
| `make xcode-ready` | Prepare repo for Xcode: resolve simulator, import payload if missing, validate, bridge-check, tool tests (`XCODE_READY_TESTS=0` to skip) |
| `make ios-list-sims` | List available iOS Simulator destinations |
| `make ios-list-devices` | List CoreDevice-visible physical devices |
| `make ios-resolve-sim` | Print resolved simulator info (override with `SIMULATOR_NAME`, `SIMULATOR_OS`, or `SIMULATOR_UDID`) |
| `make ios-doctor` | Verify Xcode, simulator, and payload-source readiness |
| `make run-sim` | Boot, install, and launch on the resolved Simulator |
| `make dev-device` | Import canonical payload and build for a generic iOS device output |
| `make run-device DEVICE_REF=<udid-or-name>` | Install and launch on a physical device |
| `make parity-smoke DEVICE_REF=<udid-or-name>` | Run the canonical payload sequentially on simulator and device |
| `make logs-sim` | Show recent simulator logs for `KeriWallet` |
| `make logs-device DEVICE_REF=<udid-or-name>` | Relaunch on device with the console attached |
| `make build` | `xcodebuild` — build KeriWallet for iOS Simulator (Debug) |
| `make open` | Open `KeriWallet.xcodeproj` in Xcode |
| `make lint` | Run SwiftLint with `--strict` on all Swift sources |
| `make test-swift` | Run Swift unit + UI tests on iOS Simulator via `xcodebuild test` |
| `make test-tools` | Run Node tool tests (`vitest run`) |
| `make test-all` | Run `test-swift` + `test-tools` in sequence |
| `make bridge-check` | Verify `BridgeContract.swift`/`BridgeContract.kt` match `bridge-contract.json` |
| `make clean` | Remove `build/DerivedData`, `test-results/`, and `dist/` |

---

## 5. npm scripts reference

These are invoked internally by `make` targets. Use `make` for day-to-day work.

| Script | Command | Notes |
|--------|---------|-------|
| `npm run bridge:check` | `gen-bridge-contract.mjs --check` | Fails if generated Swift/Kotlin contract differs from `bridge-contract.json`. |
| `npm test` | `vitest run` | Single-pass Node tool test run. |
| `npm run runtime:import` | `import-fortweb-runtime-package.mjs` | Import a canonical FortWeb runtime ZIP into `WebPayload/`. |
| `npm run check:payload` | containment + integrity + pyodide assertions | Validate the staged `WebPayload/`. |
| `npm run validate:runtime-platform-config` / `test:runtime-platform-config` | validator + `node --test` | iOS runtime-platform-config contract. |
| `npm run validate:runtime-requirements-compatibility` / `test:runtime-requirements-compatibility` | validator + `node --test` | FortWeb runtime-requirements compatibility. |
| `npm run verify:release-archive` | `assert-release-archive.mjs` | Verify the built `.xcarchive` contains the validated payload. |

---

## 6. How the payload import pipeline works

The web payload cannot be hot-reloaded in the iOS Simulator — assets must live inside the app bundle. The canonical pipeline imports the FortWeb-produced runtime package:

```
FortWeb package:runtime  →  fortweb-runtime-0.0.0.zip  →  import-fortweb-runtime-package.mjs
                                                                  ↓
                                                   WebPayload/  (manifest.json + files)
                                                                  ↓
                                        Xcode bundles WebPayload/ into the .app
```

1. **FortWeb produces the package.** `make payload-package` runs FortWeb's own
   `package:runtime` (against a pinned FortWeb checkout and the reviewed runtime
   source) and writes `dist/package/fortweb-runtime-0.0.0.zip`.
2. **Fort-ios imports it.** `make payload-import` runs
   `tools/import-fortweb-runtime-package.mjs`, which verifies the manifest, file
   hashes, entrypoint, and containment before replacing `WebPayload/`.
3. **Validation.** `make payload-contract` then runs the containment, integrity,
   Pyodide-runtime, and mobile-payload assertions against the staged
   `WebPayload/`.

> **Rule:** Always re-run `make payload-contract` after changing the payload
> source. Never manually edit `WebPayload/` or stage a FortWeb payload by direct
> copy — the import tool enforces the manifest/checksum contract.

### Determinism contract

- `WebPayload/` is import output → **must not be committed**.
- The runtime source is pinned to FortWeb release asset `runtime-source-pyodide-314-20260909` by
  archive SHA-256 (`e04833249eec88596e0f2f88d32baa6d5fae6b2e964996587061ddac4bd78c72`) and
  runtime-source manifest SHA-256
  (`87bcc689d7778840a76284471ff599cef21be41df2b429724f7f4fdc5f022135`), built from FortWeb
  branch `pyodide-314-runtime` at `bdb81af` (see `.github/workflows/ios-security.yml`).
  The previous wording said "pinned to a reviewed ref (`bdb81af` for #38)", which read as if
  `bdb81af` were the FortWeb #38 head; that head is now `de66af9` and is untested here.
- The canonical import command is `make payload-contract FORTWEB_DIR=<checkout>`.

---

## 7. Testing

Fort-ios validates the native host and its payload/contract tooling.

### Layer 1 — Swift unit tests (swift-testing)

Tests for Swift policy objects: `PayloadSchemeHandlerTests`, `AppConfigTests`, `WebBridgeTests`.

```sh
make test-swift
# or:
xcodebuild test \
  -project KeriWallet.xcodeproj \
  -scheme KeriWallet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

The test targets use Swift 5.9 (`@Suite`, `@Test`, `#expect`, `#require`). The app target stays at Swift 5.0. New `.swift` files dropped into `KeriWalletTests/` are auto-included by Xcode 16's `PBXFileSystemSynchronizedRootGroup` — no `project.pbxproj` edits needed.

### Layer 2 — Node tool tests (Vitest)

Tests for the payload import/validation and bridge/contract tooling, run in a Node environment with no browser or WASM required.

```sh
make test-tools    # single pass
```

Files: `tools/__tests__/payload-tooling.test.mjs`, `tools/__tests__/release-archive.test.mjs`, plus the standalone `node --test` suites for the runtime-platform-config and runtime-requirements-compatibility validators.

For the native wrapper itself, use `make logs-sim`, `make logs-device`, or Console.app to inspect the retained host-side breadcrumbs around initial payload load, first bridge receipt, blocked navigation, and scheme-handler failures.

### Run everything

```sh
make test-all   # test-swift + test-tools
```

---

## 8. Bridge contract

The JS↔native bridge is governed by a typed contract so all sides stay in sync.

- **Source of truth:** `bridge-contract.json` (committed)
- **Generated:** `KeriWallet/BridgeContract.swift` (Swift) and `generated/BridgeContract.kt` (Kotlin for Fort-android)
- **Verify sync:** `make bridge-check` (exits non-zero if generated output differs from committed JSON)

The generator is `tools/gen-bridge-contract.mjs`. In CI, `make bridge-check` must pass before tests run.

Message envelope shape (JS → Swift):

```json
{ "type": "lifecycle | js_error | log | crypto_result | unhandled_rejection", "timestamp": "<ISO 8601>", ... }
```

---

## 9. Repository layout

```
Fort-ios/
├── KeriWallet/                     # Swift sources
│   ├── AppDelegate.swift
│   ├── AppLogger.swift             # OSLog-backed structured logging
│   ├── AppConfig.swift             # App-wide constants (schemes, limits, payload dir)
│   ├── BridgeContract.swift        # Generated — do not edit by hand
│   ├── PayloadSchemeHandler.swift  # WKURLSchemeHandler serving WebPayload/
│   ├── WebBridge.swift             # WKScriptMessageHandler — decodes bridge envelopes
│   ├── WebContainerViewController.swift
│   ├── WebNavigationPolicy.swift   # Deny-by-default navigation allowlist
│   └── PrivacyInfo.xcprivacy
├── KeriWalletTests/                # Swift unit tests (swift-testing)
├── KeriWalletUITests/              # Swift UI tests
├── KeriWallet.xcodeproj            # Xcode project
├── tools/                          # Node payload/contract tooling
│   ├── gen-bridge-contract.mjs     # Generates BridgeContract.swift + BridgeContract.kt
│   ├── import-fortweb-runtime-package.mjs  # Imports canonical FortWeb ZIP into WebPayload/
│   ├── assert-*.mjs                # Payload containment/integrity/pyodide/archive assertions
│   ├── validate-*.mjs              # runtime-platform-config + runtime-requirements validators
│   └── __tests__/                  # Vitest tool tests
├── scripts/
│   └── resolve-ios-simulator.py
├── WebPayload/                     # Imported canonical FortWeb runtime — Xcode bundles this (gitignored)
├── generated/
│   └── BridgeContract.kt           # Generated Kotlin constants (for Fort-android)
├── Config/
│   ├── Debug.xcconfig
│   └── Release.xcconfig
├── bridge-contract.json            # Source of truth for the native bridge
├── Makefile                        # All developer commands — start here
├── vitest.config.ts                # Node tool-test runner config
├── package.json                    # Node tooling scripts (vitest only)
└── .tool-versions                  # Pins Node 22.12.0 via mise
```

> **Generated files:** never hand-edit `KeriWallet/BridgeContract.swift`, `generated/BridgeContract.kt`, or `WebPayload/`. Regenerate/import via `make bridge-check` / `make payload-contract`.

---

## 10. Documentation index

### Workspace Architecture Decision Records

These ADRs are owned by the `keri-notes` workspace and live in `keri-notes/docs/adr/`. They are
intentionally not duplicated in this repo, so they are referenced by path instead of by relative
link (the earlier relative links under `docs/adr/` were broken after the dedup commit `86cf5b7`).

| ADR | Title | Summary |
|-----|-------|---------|
| `ADR-022-ios-wkwebview-pyodide-bundled-payload.md` | Bundled payload decision | Why all assets are bundled at build time (no runtime download) |
| `ADR-023-ios-wrapper-architecture.md` | iOS wrapper architecture | UIKit + WKWebView + custom scheme handler design |
| `ADR-024-web-payload-build-bundling.md` | Web payload build & bundling | Deterministic build and bundle staging |
| `ADR-025-ios-build-ci-developer-workflow.md` | iOS build/CI & developer workflow | VS Code + `xcodebuild` golden path, CI recipe |
| `ADR-026-ios-logging-strategy.md` | iOS logging strategy | `AppLogger`, privacy-aware OSLog usage |
| `ADR-031-cross-platform-shared-web-payload.md` | Cross-platform shared web payload | Thin native wrappers around one shared web payload |
| `ADR-051-android-native-wrapper-thin-webview-host.md` | Android thin host | Android wrapper posture aligned with the iOS thin-host goal |

### Governance

Engineering governance for this repo (Swift coding, Xcode workflow, WKWebView and payload rules) is owned by the `keri-notes` workspace and routed by `applyTo` globs; it is intentionally not duplicated inside this fork. See `keri-notes/.github/instructions/`.

### Release and acceptance evidence

| File | Purpose |
|------|---------|
| `docs/app-store-submission-checklist.md` | Gate lanes, manual App Store items, export compliance, and known blockers |
| `keri-notes/docs/architecture/mobile-runtime-compatibility.md` | Canonical runtime compatibility and acceptance matrix for both mobile consumers |

The `CONFERENCE-IOS-VALIDATION-CHECKLIST.md` and `CONFERENCE-IOS-VALIDATION-RUNS.md` files that
earlier revisions of this README referenced were removed in `2b67924` and do not exist in this
repository.

---

## 11. App Store compliance

The bundled Pyodide payload requires one producer-side sanitization before App Store submission.

### `itms-services` handling in `python_stdlib.zip`

The pinned generic Pyodide Python standard library contains CPython's `itms-services` URL-scheme handling in `urllib/parse.py`. CPython documents that scheme as an App Store review compatibility issue and removes the handling when CPython is built for iOS, so a generic stdlib carries a release-compatibility risk.

Fort-ios does not rewrite canonical runtime bytes. Instead:

- `make release-content-check` scans the staged `WebPayload/`, descending into nested archives, for that material.
- `tools/assert-release-archive.mjs` applies the same gate to the payload inside a release `.xcarchive`.

Because the current pinned producer artifact still contains this handling, the gate reports a finding and the artifact is not App-Store-clean until the canonical runtime producer sanitizes it before publishing its manifest, digests, and package ZIP. The marker and the scan scope are declared in `tools/release-sanitization-policy.json` under `release_content_gate`.

### Privacy manifest

`KeriWallet/PrivacyInfo.xcprivacy` declares the Required Reason APIs used by the wrapper. Keep this up to date when adding new APIs. The first TestFlight upload will surface any missing declarations.

### Reviewer notes (include with every submission)

> The app runs a bundled, immutable WebAssembly payload. No executable code is downloaded at runtime. Navigation is locked to the `app://` custom scheme — this is not a browser.
