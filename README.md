# Fort-ios

Fort-ios is the KERI Foundation's iOS wallet host. It is a native UIKit app that
hosts the FortWeb runtime in a `WKWebView` and provides the native app shell and
JavaScript bridge.

Fort-ios builds and packages the iOS host. The wallet's web runtime is produced
by [FortWeb](https://github.com/keri-foundation/fortweb) and bundled into the app.

## Requirements

- macOS with Xcode 26.5, the iOS 26.5 SDK, and an iOS 26.5 Simulator runtime.
- The deployment target is iOS 16.4. The minimum supported Xcode version is not
  verified; the last older version validated was 26.4.1.
- [mise](https://mise.jdx.dev/) to install the Node version pinned in
  `.tool-versions` (22.12.0).
- SwiftLint (`brew install swiftlint`) to run Swift linting.

The app bundles Pyodide 314.0.5 and Python 3.14.2. Fort-ios does not build or
vendor that runtime.

## First-time setup

Prepare a FortWeb checkout beside this repository at `../fortweb`, following the
[developer guide](docs/developer-guide.md). From the Fort-ios repository root,
install the tools, validate the runtime package, prepare Xcode, and open the
project:

```sh
mise install
npm ci
make payload-contract FORTWEB_DIR=../fortweb
make xcode-ready FORTWEB_DIR=../fortweb
make open
```

`make xcode-ready` resolves a simulator, imports the runtime package when
`WebPayload/` is absent, and checks the payload and bridge contracts.

## Build and run

Build and launch on the resolved simulator:

```sh
make build
make run-sim
```

To choose a simulator explicitly:

```sh
make build SIMULATOR_NAME="iPhone 17 Pro" SIMULATOR_OS=26.5
```

For a physical device:

```sh
make dev-device
make run-device DEVICE_REF=<udid-or-name>
```

## Common checks

```sh
make lint
make test-tools
make test-swift
```

`make parity-smoke DEVICE_REF=<udid-or-name>` provides build, install, and launch
smoke support on simulator and device.

## More documentation

- [App Store submission checklist](docs/app-store-submission-checklist.md) for
  release requirements and certification status.
