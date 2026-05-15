# Known-Good iOS Baseline

Date captured: 2026-05-14

This note freezes the current Fort-ios review baseline as a reproducible tuple. Before diagnosing a new iOS regression, restore this exact state first.

## Wrapper tuple

- Branch: `fix/ios-mobile-consolidated-review`
- HEAD: `40f1f81` (`chore(ios): add deterministic FortWeb ref staging`)
- Origin: `git@github.com:keri-foundation/fortios.git`
- Worktree expectation: clean

## Payload tuple

- FortWeb `git_sha`: `214643f4fa907061334c09c8297c4d1e59f18f45`
- `dist_tree_sha256`: `9a3e63d81c0c7f916775dc208ed7c9029f83a6ccfea5d2a8098a218cf2bb1542`
- `producer`: `fortweb-shared`
- `payload_profile`: `product-shell`
- `source_git_status`: `clean`

## iOS loading model

- Stable local origin: `app://local/index.html`
- Defined in [xcodeproj/KeriWallet/KeriWallet/AppConfig.swift](xcodeproj/KeriWallet/KeriWallet/AppConfig.swift)
- Served by [xcodeproj/KeriWallet/KeriWallet/PayloadSchemeHandler.swift](xcodeproj/KeriWallet/KeriWallet/PayloadSchemeHandler.swift)

## Validation lane

- Simulator: `iPhone 16e`
- OS: `iOS 26.0`
- Functional proof at capture time: successful vault create, vault open/login, and logged-in Identifiers shell
- Expected bottom navigation: `Identifiers`, `Remotes`, `Foundation`, `Settings`

## Restore this exact baseline

```sh
make PAYLOAD_SOURCE=fortweb \
  FORTWEB_FETCH=1 \
  FORTWEB_REMOTE=/Users/jay-alexanderelliot/Projects/keri-notes/libs/fortweb \
  FORTWEB_REF=214643f4fa907061334c09c8297c4d1e59f18f45 \
  payload-contract
```

## Verify the staged manifest

Confirm [WebPayload/build-manifest.json](WebPayload/build-manifest.json) reports all of these fields:

- `git_sha = 214643f4fa907061334c09c8297c4d1e59f18f45`
- `dist_tree_sha256 = 9a3e63d81c0c7f916775dc208ed7c9029f83a6ccfea5d2a8098a218cf2bb1542`
- `producer = fortweb-shared`
- `payload_profile = product-shell`
- `source_git_status = clean`

## Manual validation checklist

- Start from a fresh install or a clean simulator state if prior local storage is suspect.
- Launch on `iPhone 16e` / `iOS 26.0`.
- Create a test vault.
- Open/login to the test vault.
- Confirm the logged-in Identifiers shell renders.
- Confirm bottom navigation shows `Identifiers`, `Remotes`, `Foundation`, `Settings`.
- Capture a screenshot or note the evidence path used for the pass.

## Explicit non-baseline states

- Dirty FortWeb HEAD
- Hand-edited `WebPayload`
- `49aaecb1373ee1c25605b94aa1ddb50975b09c25`
- `6746bcf695d2e552d621cf28a27c497dce0251e7`

## Regression rule

Before diagnosing a future iOS regression, first restore this exact wrapper tuple, payload tuple, and simulator lane, then reproduce from there.