# Fort-ios

**Fort-ios** is the KERI Foundation iOS wallet host repo. It is a thin native wrapper: a UIKit app with a `WKWebView` that serves the **canonical FortWeb runtime package** via a custom `app://` scheme handler.

| Layer | What it is | Where it lives |
|-------|-----------|----------------|
| **iOS native host** | UIKit + `WKWebView`, custom `app://` payload scheme handler, deny-by-default navigation allowlist, typed JS↔native bridge | `KeriWallet/`, `KeriWallet.xcodeproj` |
| **Node tooling** | Payload import/validation and bridge-contract generation used by `make` and CI | `tools/` |

There is no in-repo browser/JS build. The web payload is the canonical FortWeb runtime package produced by FortWeb's own `package:runtime` tooling from a reviewed runtime source ([FortWeb repository](https://github.com/keri-foundation/fortweb), [runtime package contract at the producer revision used by CI](https://github.com/keri-foundation/fortweb/blob/bdb81afa7593603141e8db306f0636a583d2db02/docs/runtime-package-contract.md)). Fort-ios imports that ZIP into `WebPayload/` (`make payload-import`), validates it, and bundles it at build time. The navigation policy constrains document navigation, but it does not establish that JavaScript fetch or other network requests are blocked. An isolated macOS test demonstrated that this guarantee is not established; full iOS network behavior has not been tested.

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
`DEVELOPER_DIR=/Applications/Xcode_26.5.app/Contents/Developer` and resolves an
`iPhone 17 Pro` simulator on iOS 26.5.

The deployment target remains **iOS 16.4** and is independent of the installed
simulator runtime. Older Xcode compatibility has not been revalidated against
the current project format.

| Attribute | Value |
|-----------|-------|
| Minimum supported Xcode | Not verified; last validated with 26.4.1 |
| Currently verified Xcode | 26.5 (hosted CI) |
| Currently verified iOS SDK | 26.5 (hosted CI) |
| Deployment target | 16.4 |
| Currently verified simulator runtime | 26.5 (hosted CI) |
| Swift language mode | 5 |
| Project object version | 77 |

> mise manages the Node version — you do not need to install Node manually.

### Python runtime (bundled FortWeb payload)

The canonical FortWeb runtime package used by this workflow contains Pyodide
**314.0.5** and Python **3.14.2**. Fort-ios does not build or vendor Python
itself; its payload checks validate the package before bundling. These are the
runtime versions in the package, not the host Python used by the build tools.

The producer input is the FortWeb release asset
[`runtime-source-pyodide-314-20260909`](https://github.com/keri-foundation/fortweb/releases/tag/runtime-source-pyodide-314-20260909).
The Makefile pins the expected source-manifest SHA-256 used when packaging. CI
also supplies that manifest digest, pins the source archive SHA-256, and checks
out FortWeb at the exact producer commit
[`bdb81afa7593603141e8db306f0636a583d2db02`](https://github.com/keri-foundation/fortweb/commit/bdb81afa7593603141e8db306f0636a583d2db02).
The runtime package contract is documented in the
[FortWeb repository](https://github.com/keri-foundation/fortweb/blob/bdb81afa7593603141e8db306f0636a583d2db02/docs/runtime-package-contract.md).
The runtime-version details are in the
[FortWeb Pyodide 314 build documentation](https://github.com/keri-foundation/fortweb/blob/bdb81afa7593603141e8db306f0636a583d2db02/docs/pyodide-314-wheel-build.md).
The mobile runtime compatibility matrix and related architecture decisions are
maintained in the `keri-notes` workspace; contributors need access to that
workspace checkout to read them. They are not included in a standalone Fort-ios
checkout.

---

## 2. First-time setup

Run these commands once after cloning Fort-ios. A fresh Fort-ios checkout does
not contain the prepared FortWeb runtime, so obtain and build that producer
input before importing the payload or building the iOS app. The FortWeb source
repository and release asset are public; the workspace compatibility matrix
and ADRs require access to a `keri-notes` workspace checkout.

```sh
# 1. Clone Fort-ios and install its pinned Node version and tooling
git clone https://github.com/keri-foundation/Fort-ios.git
cd Fort-ios
curl https://mise.run | sh   # skip if mise is already installed
mise install                  # reads .tool-versions → installs Node 22.12.0
npm ci

# 2. Get the exact FortWeb producer checkout used by CI
git clone https://github.com/keri-foundation/fortweb.git ../fortweb
git -C ../fortweb checkout bdb81afa7593603141e8db306f0636a583d2db02
npm ci --prefix ../fortweb

# 3. Acquire the reviewed runtime source archive and verify both digests
export FORTWEB_RUNTIME_SOURCE_URL=https://github.com/keri-foundation/fortweb/releases/download/runtime-source-pyodide-314-20260909/runtime-source.tar.gz
export FORTWEB_RUNTIME_SOURCE_ARCHIVE_SHA256=e04833249eec88596e0f2f88d32baa6d5fae6b2e964996587061ddac4bd78c72
export FORTWEB_RUNTIME_SOURCE_MANIFEST=build/runtime-source/manifest.json
export FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256=87bcc689d7778840a76284471ff599cef21be41df2b429724f7f4fdc5f022135
(cd ../fortweb && python3 scripts/acquire_runtime_source.py \
  --url "$FORTWEB_RUNTIME_SOURCE_URL" \
  --sha256 "$FORTWEB_RUNTIME_SOURCE_ARCHIVE_SHA256" \
  --manifest-sha256 "$FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256" \
  --output build/runtime-source)

# 4. Install the producer build tools from the verified local wheelhouse and build dist/runtime
python3 -m pip install --no-index --no-deps \
  ../fortweb/build/runtime-source/wheelhouse/packaging-26.1-py3-none-any.whl \
  ../fortweb/build/runtime-source/wheelhouse/setuptools-83.0.0-py3-none-any.whl \
  ../fortweb/build/runtime-source/wheelhouse/wheel-0.47.0-py3-none-any.whl
(cd ../fortweb && \
  FORTWEB_RUNTIME_SOURCE_MANIFEST="$FORTWEB_RUNTIME_SOURCE_MANIFEST" \
  FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256="$FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256" \
  npm run build:runtime)

# 5. Produce/import the canonical package and validate WebPayload, then build
make payload-contract FORTWEB_DIR=../fortweb
make build
```

The host build tools use Python 3.12 in CI; install Python 3.12 before running
the acquisition and build commands if `python3` does not select it. The Pyodide
interpreter shipped in the payload is Python 3.14.2. Keep the producer checkout
at the reviewed commit above; a moving branch or tag is not a substitute for
that commit.

---

## 3. Daily workflow

### Quick start — prepare for Xcode

```sh
# One command to prepare the repo for opening in Xcode:
make xcode-ready FORTWEB_DIR=../fortweb

# Then open Xcode and press Play.
make open
```

This resolves a simulator, imports the canonical FortWeb runtime package when
`WebPayload/` is absent, validates the payload contract, and checks the bridge
contract. It requires the FortWeb runtime input to have been acquired and built
as described in section 2. Use `make xcode-ready XCODE_READY_TESTS=0` to skip
the Node tool tests.

### Simulator selection

The Makefile auto-resolves a single iPhone simulator:

```
# Auto-detect (single booted → newest runtime → preferred model):
make build

# Override by name:
make build SIMULATOR_NAME="iPhone 16"

# Override by name + OS version:
make build SIMULATOR_NAME="iPhone 17 Pro" SIMULATOR_OS=26.5

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
make payload-contract FORTWEB_DIR=../fortweb

# 4. Run the fast local checks
make lint                      # SwiftLint (Swift sources)
make test-tools                # Node tool tests (Vitest)

# 5. Build and launch on Simulator
make build
make run-sim

# 6. Build and launch on physical device
make dev-device
make run-device DEVICE_REF=<udid-or-name>

# 7. Optional build, install, and launch smoke support on simulator and device
make parity-smoke DEVICE_REF=<udid-or-name>
make logs-sim
make logs-device DEVICE_REF=<udid-or-name>
```

For release evidence, use [docs/app-store-submission-checklist.md](docs/app-store-submission-checklist.md).
`make parity-smoke` imports the payload, builds the app, and installs and launches
it on the selected simulator and device. It supports build/install/launch smoke
checks; a green run does not prove wallet acceptance, vault creation or unlock,
populated-state persistence, or end-to-end KERI service acceptance. The separate
UI tests also have paths that return successfully when no vault is present or
when navigation to an unlocked vault does not complete, so their green result
does not establish those behaviors either.

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
| `make parity-smoke DEVICE_REF=<udid-or-name>` | Build, install, and launch the canonical payload on simulator and device |
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
| `npm run verify:release-archive` | `assert-release-archive.mjs` | Run default archive integrity checks; this lane never certifies a release and may pass with `NOT_CERTIFIED`. |
| `npm run certify:release-archive` | `assert-release-archive.mjs --release-certification` | Apply the release-certification lane, including producer-owned findings. |

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
- The Makefile's `FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256` pins the expected
  source-manifest digest for local packaging. CI supplies that manifest digest,
  pins the source archive digest, and checks out FortWeb at commit
  `bdb81afa7593603141e8db306f0636a583d2db02`. These values have separate roles;
  see `.github/workflows/ios-security.yml` and the setup steps above.
- The canonical import command is `make payload-contract FORTWEB_DIR=<checkout>`.

### Archive integrity and release certification

The default archive verifier checks archive structure, payload identity, file
integrity, and wrapper-owned assertions. Producer-owned release-content and
offline-closure findings are reported but not enforced in this lane. A successful
default verification can therefore print `certification: NOT_CERTIFIED`; the
PR lane never certifies a release. Run the release-certification path to enforce
all gates:

```sh
npm run verify:release-archive -- --archive build/KeriWallet.xcarchive
npm run certify:release-archive -- --archive build/KeriWallet.xcarchive --evidence build/release-evidence.json
# Equivalent Make target:
make release-certify ARCHIVE_PATH=build/KeriWallet.xcarchive
```

The certification path applies producer-owned gates as well as wrapper-owned
checks. Current outstanding producer findings include `itms-services` handling
inside the generic Pyodide `python_stdlib.zip` and offline-closure markers such
as CDN, loopback, `file://`, or source-checkout dependencies in the producer
payload. They are reported in the default lane and enforced by release
certification; passing default archive integrity checks does not mean those
findings are fixed or that a release is certified. See the
[submission checklist](docs/app-store-submission-checklist.md) for gate status.

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

These ADRs are owned by the `keri-notes` workspace and are not duplicated in
this repository. The paths below are workspace-relative and available to
contributors with access to a `keri-notes` workspace checkout; they are not
links into a standalone Fort-ios checkout.

| Workspace path | Title | Summary |
|---------------|-------|---------|
| `docs/adr/ADR-022-ios-wkwebview-pyodide-bundled-payload.md` | Bundled payload decision | Decision record for the bundled payload approach |
| `docs/adr/ADR-023-ios-wrapper-architecture.md` | iOS wrapper architecture | UIKit + WKWebView + custom scheme handler design |
| `docs/adr/ADR-024-web-payload-build-bundling.md` | Web payload build & bundling | Deterministic build and bundle staging |
| `docs/adr/ADR-025-ios-build-ci-developer-workflow.md` | iOS build/CI & developer workflow | VS Code + `xcodebuild` developer workflow and CI recipe |
| `docs/adr/ADR-026-ios-logging-strategy.md` | iOS logging strategy | `AppLogger`, privacy-aware OSLog usage |
| `docs/adr/ADR-031-cross-platform-shared-web-payload.md` | Cross-platform shared web payload | Thin native wrappers around one shared web payload |
| `docs/adr/ADR-051-android-native-wrapper-thin-webview-host.md` | Android thin host | Android thin-host decision record |

### Governance

Engineering governance for this repo (Swift coding, Xcode workflow, WKWebView and payload rules) is owned by the `keri-notes` workspace and routed by `applyTo` globs; it is intentionally not duplicated inside this repository. Contributors need access to the `keri-notes` workspace or repository. Relevant files include `.github/instructions/ios-wkwebview-pyodide-bundled-payload.instructions.md` and `.github/instructions/mobile-workflow-governance.instructions.md`.

### Release and acceptance evidence

| File | Purpose |
|------|---------|
| [docs/app-store-submission-checklist.md](docs/app-store-submission-checklist.md) | Gate lanes, manual App Store items, export compliance, and known blockers |
| `docs/architecture/mobile-runtime-compatibility.md` in the `keri-notes` workspace | Canonical runtime compatibility and acceptance matrix for both mobile consumers; requires access to a `keri-notes` workspace checkout |

---

## 11. App Store compliance

The bundled Pyodide payload requires one producer-side sanitization before App Store submission.

### `itms-services` handling in `python_stdlib.zip`

The pinned generic Pyodide Python standard library contains CPython's `itms-services` URL-scheme handling in `urllib/parse.py`. This is a release-content finding recorded by the current checks.

Fort-ios does not rewrite canonical runtime bytes. Instead:

- `make release-content-check` scans the staged `WebPayload/`, descending into nested archives, for that material.
- `tools/assert-release-archive.mjs` applies the same gate to the payload inside a release `.xcarchive`.

Because the current pinned producer artifact still contains this handling, the gate reports a finding and the artifact is not App-Store-clean until the canonical runtime producer sanitizes it before publishing its manifest, digests, and package ZIP. The marker and the scan scope are declared in `tools/release-sanitization-policy.json` under `release_content_gate`.

### Privacy manifest

`KeriWallet/PrivacyInfo.xcprivacy` declares the Required Reason APIs used by the wrapper. Keep this up to date when adding new APIs. The first TestFlight upload will surface any missing declarations.

### Reviewer notes

Describe the bundled payload and the navigation policy as implemented. Do not
claim that the navigation policy blocks JavaScript fetch requests or that all
network access is prevented; that behavior has not been established. The
isolated macOS test does not prove full iOS network behavior.
