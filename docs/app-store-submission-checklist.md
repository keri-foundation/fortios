# App Store submission checklist and evidence

Repository-enforceable checks are automated; everything else is listed here so nothing
ships unverified. Status meanings:

- **VERIFIED** — evidence exists in this repository or its tooling output.
- **NOT_APPLICABLE** — the product does not use the capability; evidence given.
- **MANUAL_CONFIRMATION_REQUIRED** — only App Store Connect or a human can confirm.
- **OWNER_INPUT_REQUIRED** — the repository cannot determine product intent.

`make release-content-check` and `node tools/assert-release-archive.mjs --archive <path.xcarchive>`
enforce the automated parts (release content, bundle structure, submission declarations).

## 1. Automated gates (repository-enforceable)

| Gate | What it proves | Status |
|---|---|---|
| Privacy manifest structure | `PrivacyInfo.xcprivacy` present at app root, valid plist, only Apple's four top-level keys, known API categories with approved reason codes | VERIFIED (validator + tests) |
| Required-reason coverage | Every observed first-party API category is declared; declared-but-unused categories reported as stale | VERIFIED (static scan; UserDefaults currently reported stale — see §3) |
| Capability closure | No broad ATS bypass, no undeclared permission purpose strings, URL schemes, background modes, Bonjour, local network, or document exposure | VERIFIED (validator + tests) |
| Bundle structure and content | Cruft closure, nested-archive allowlist, canonical payload identity, secrets, size budgets, release content | VERIFIED (see `release-sanitization-policy.json`) |

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
