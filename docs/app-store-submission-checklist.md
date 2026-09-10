# App Store submission checklist and evidence

Repository-enforceable checks are automated; everything else is listed here so nothing
ships unverified. Status meanings:

- **VERIFIED** — evidence exists in this repository or its tooling output.
- **NOT_APPLICABLE** — the product does not use the capability; evidence given.
- **MANUAL_CONFIRMATION_REQUIRED** — only App Store Connect or a human can confirm.
- **OWNER_INPUT_REQUIRED** — the repository cannot determine product intent.

`make release-content-check` and `node tools/assert-release-archive.mjs --archive <path.xcarchive>`
enforce the automated parts (release content, bundle structure, submission declarations).

## 0. Gate lanes and the trust chain

Checks are grouped by the trust boundary they protect. Confusing the lanes is how a gate
starts lying: a PR-lane pass is not a release certification, and a certification failure is
not a PR regression.

| Lane | Where it runs | What it enforces |
|---|---|---|
| AUTOMATED PR GATE | `ios-security.yml`, `repo-hygiene.yml` on every relevant PR | Wrapper-owned invariants: payload identity and contract, bundle structure, submission declarations, SwiftLint, Knip, tracked-tree hygiene |
| AUTOMATED RELEASE GATE | `release-certification.yml` (`workflow_dispatch` only) | Every invariant, including producer-owned payload content. Expected to fail while the canonical FortWeb runtime is unsanitized |
| RELEASE-CANDIDATE MANUAL / APPLE GATE | Organizer, App Store Connect, TestFlight | Signing, entitlements, privacy nutrition labels, export compliance, review access |

The intended chain, with the owner of each step:

```
source / PR                     wrapper
  -> deterministic CI           wrapper
  -> trusted release build      wrapper
  -> final archive assertion    wrapper
  -> distribution signing       release candidate (not yet started)
  -> TestFlight                 release candidate
  -> App Store Connect review   owner + Apple
```

A PR-lane pass prints `certification: NOT_CERTIFIED` on purpose. Only
`--release-certification` can print `CERTIFIED`.

## 1. Automated gates (repository-enforceable)

| Gate | Lane | What it proves | Status |
|---|---|---|---|
| Tracked-tree hygiene | PR | `build/`, derived data, archives, `.deps/`, `.env`, private keys, and credential bundles are absent from `git ls-files`, including files added with `git add -f` | VERIFIED (validator + tests; `.gitignore` is convenience, this gate is the boundary) |
| Privacy manifest structure | PR + release | `PrivacyInfo.xcprivacy` present at app root, valid plist, only Apple's four top-level keys, known API categories with approved reason codes | VERIFIED (validator + tests) |
| Required-reason coverage | PR + release | Every observed first-party API category is declared; declared-but-unused categories reported as stale | VERIFIED (static scan; UserDefaults currently reported stale — see §3) |
| Capability closure | PR + release | No broad ATS bypass, no undeclared permission purpose strings, URL schemes, background modes, Bonjour, local network, or document exposure | VERIFIED (validator + tests) |
| Bundle structure and payload identity | PR + release | Cruft closure, nested-archive allowlist, canonical payload byte identity, secrets, size budgets | VERIFIED (see `release-sanitization-policy.json`) |
| Release content (forbidden markers) | Release only | No `itms-services` (or other gated marker) anywhere in the payload, including inside nested ZIPs | ENFORCED IN CERTIFICATION — currently FAILING on producer-owned `python_stdlib.zip` |
| Offline runtime closure | Release only | No CDN, loopback, `file://`, or source-checkout dependency in the runtime payload | ENFORCED IN CERTIFICATION — producer-owned debt reported in the PR lane |

Producer-owned invariants are declared in `producer_owned` in
`tools/release-sanitization-policy.json`. They are reported in both lanes and enforced by
certification, so a red certification run on an unshippable artifact is the gate working, not
a defect in CI.

## 2. App Store Connect (manual)

| Item | Status | Note |
|---|---|---|
| Privacy policy URL | MANUAL_CONFIRMATION_REQUIRED | Required for submission |
| App privacy disclosures (nutrition labels) | MANUAL_CONFIRMATION_REQUIRED | Reconcile with §3 before answering |
| App description / keywords | MANUAL_CONFIRMATION_REQUIRED | Must describe what actually ships |
| Screenshots and previews | MANUAL_CONFIRMATION_REQUIRED | Capture from the release candidate |
| Age rating | MANUAL_CONFIRMATION_REQUIRED | Product decision |
| Content rights | MANUAL_CONFIRMATION_REQUIRED | Product decision |
| Category | MANUAL_CONFIRMATION_REQUIRED | Product decision |
| Review contact information | MANUAL_CONFIRMATION_REQUIRED | Keep current or review stalls |
| Demo credentials / review access | OWNER_INPUT_REQUIRED | See §5 |
| Backend services live during review | MANUAL_CONFIRMATION_REQUIRED | Witnesses, watchers, onboarding endpoints must be reachable |
| Export compliance answers | OWNER_INPUT_REQUIRED | See §4 |
| TestFlight final candidate | MANUAL_CONFIRMATION_REQUIRED | Resolve feedback before App Review |

## 3. Privacy declaration reconciliation

| Data practice | `PrivacyInfo.xcprivacy` | Xcode privacy report | App Store Connect labels |
|---|---|---|---|
| Tracking | `NSPrivacyTracking = false`, no tracking domains (VERIFIED) | Generate from the release archive in Organizer | Must match: no tracking |
| Collected data types | `NSPrivacyCollectedDataTypes = []` (VERIFIED as declared) | Reconcile with third-party manifests | OWNER_INPUT_REQUIRED: confirm the app collects nothing reportable |
| Required-reason APIs | FileTimestamp `C617.1` observed in `PayloadSchemeHandler.swift` (VERIFIED) | Reconcile | Not disclosed as data collection |
| UserDefaults `CA92.1` | Declared but **no first-party usage found** — classified stale, advisory only | Reconcile | n/a |

The `UserDefaults` declaration is intentionally left in place: removing a declaration is an
owner decision, not an automatic fix, and the automation reports it rather than editing it.

Xcode's privacy report is an Organizer flow (`Archive` → `Generate Privacy Report`). No
supported command-line equivalent is relied on here, and no report is fabricated.

## 4. Export compliance evidence

This app ships cryptographic functionality, so it cannot be declared as "no encryption".

| Component | Purpose | Family | System or bundled | Standard or custom |
|---|---|---|---|---|
| Apple system TLS (WKWebView / URLSession) | HTTPS transport for wallet services | TLS 1.2+ | system | standard |
| `keri` (bundled wheel) | KERI key events, CESR signing/verification, pre-rotation | Ed25519/ECDSA via libsodium-backed primitives | bundled (WASM) | standard algorithms, custom protocol |
| `pysodium` (bundled wheel) | Cryptographic primitives for KERI operations | libsodium | bundled (WASM) | standard |
| `cryptography` / `cffi` (bundled wheels) | Keystore and key material handling | OpenSSL-backed primitives | bundled (WASM) | standard |

`ITSAppUsesNonExemptEncryption` is **absent** from the final Info.plist. The disposition is
`EXPORT_COMPLIANCE_OWNER_REVIEW_REQUIRED`: the inventory above is the evidence needed to answer
Apple's determination questions, and this document is not a legal determination.

## 5. Reviewer notes template

> KeriWallet runs a bundled, immutable WebAssembly wallet runtime. No executable code is
> downloaded at runtime; navigation is restricted to the app's own scheme.
>
> **Review access:** `DEMO_CREDENTIALS_PROVIDED_IN_APP_STORE_CONNECT`
> **Onboarding bootstrap:** `DEMO_OOBI_OR_QR_PROVIDED_IN_APP_STORE_CONNECT`
> **Live services during review:** `WITNESS_AND_WATCHER_ENDPOINTS_LISTED_IN_APP_STORE_CONNECT`
> **Vault creation:** create a vault with any alias and passcode; no server account is required.

Never store real credentials, OOBIs, or endpoint secrets in this repository.

## 6. Account deletion applicability

`DOES_APP_CREATE_A_SERVICE_ACCOUNT = UNCLEAR` → OWNER_INPUT_REQUIRED.

Distinguish carefully:

- A local KERI vault/identifier is created and stored on device. That is not a remotely managed
  user account.
- The bundled runtime exposes hosted onboarding and account-scoped service calls
  (`kf.bootstrap.get`, `kf.onboarding.start`, `kf.account.witnesses.list`,
  `kf.account.watchers.list`, `kf.account.watchers.status`). If any of those create a hosted
  account on the user's behalf, Apple's in-app account-deletion requirement applies.

No account-deletion flow was implemented in this slice; this is a product decision to confirm.

## 7. Third-party native SDKs

No third-party native SDKs are linked: the Xcode project declares no package references, there is
no CocoaPods or Carthage manifest, and the archived app contains a single Mach-O executable.
Apple's "SDKs that require a privacy manifest and signature" obligations therefore do not apply to
linked native code. The Pyodide Python wheels are runtime payload content under canonical payload
closure, not native SDK frameworks.

Distribution-signature proof (`codesign` identity per code item) is deferred to the release
candidate slice, because this repository's CI archives are intentionally unsigned.

## 8. Workflow hardening exceptions

| Item | Status | Note |
|---|---|---|
| Action pinning | ACTION_PIN_UNVERIFIED (1 of 5 refs) | `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` are pinned to full commit SHAs. `actions/setup-python` still floats on `v5`: its commit SHA could not be resolved while the workflows were hardened, and inventing one is worse than recording it. `tools/__tests__/workflow-security.test.mjs` fails if any other action floats, and fails if this exception is removed without resolving the pin |
| Signing credentials in CI | NOT_APPLICABLE | Every CI archive is built with `CODE_SIGNING_ALLOWED=NO`; no certificate, key, or provisioning profile is loaded by any workflow |
| Release evidence | VERIFIED | `release-certification.yml` uploads the assertion evidence (source commit SHA, archive SHA-256, bundle bill of materials, declaration inventory, violations) with 90-day retention |
| Baseline regeneration in CI | VERIFIED as blocked | `.swiftlint-baseline.json` is a reviewed input. `make lint-baseline` is local-only, and the workflow contract test fails if any workflow invokes it or passes `--write-baseline` |
