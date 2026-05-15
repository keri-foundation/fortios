.DEFAULT_GOAL := help

XCODE_PROJECT := xcodeproj/KeriWallet/KeriWallet.xcodeproj
SCHEME        := KeriWallet
APP_BUNDLE_ID := com.kerifoundation.wallet
PAYLOAD_SOURCE ?= fortweb
FORTWEB_DIR   ?= ../fortweb
FORTWEB_FETCH ?= 0
FORTWEB_REF ?= 214643f4fa907061334c09c8297c4d1e59f18f45
FORTWEB_REMOTE ?= https://github.com/keri-foundation/fortweb.git
SIMULATOR_NAME ?= iPhone 17 Pro
SIMULATOR_OS   ?= auto
SIMULATOR_UDID ?=
ifneq ($(strip $(SIMULATOR_UDID)),)
SIMULATOR_DEVICE := $(SIMULATOR_UDID)
else
SIMULATOR_DEVICE := $(shell bash scripts/resolve-simulator-udid.sh "$(SIMULATOR_NAME)" "$(SIMULATOR_OS)" 2>/dev/null)
endif
ifneq ($(strip $(SIMULATOR_DEVICE)),)
SIMULATOR_DEST := platform=iOS Simulator,id=$(SIMULATOR_DEVICE)
else
SIMULATOR_DEST := platform=iOS Simulator,name=$(SIMULATOR_NAME)
endif
SIM_DERIVED_DATA := build/DerivedData-sim
DEVICE_DERIVED_DATA := build/DerivedData-device
TEST_RESULTS  := build/TestResults.xcresult
ARCHIVE_PATH  := build/KeriWallet.xcarchive
EXPORT_DIR    := build/export
EXPORT_OPTS   := ExportOptions.plist
SIM_APP_PATH  := $(SIM_DERIVED_DATA)/Build/Products/Debug-iphonesimulator/KeriWallet.app
DEVICE_APP_PATH := $(DEVICE_DERIVED_DATA)/Build/Products/Debug-iphoneos/KeriWallet.app
DEVICE_REF    ?=

.PHONY: help setup pyodide sync sync-fortweb payload-contract ios-doctor ios-list-sims ios-list-devices require-simulator require-device-ref focus-sim build build-sim install-sim launch-sim run-sim dev-sim build-device install-device launch-device run-device dev-device parity-smoke logs-sim logs-device test-swift test-ts test-e2e test-e2e-slow test-all bridge-check lint lint-ts open clean archive export upload

help: ## Show available make targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##"}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Shared targets (platform-agnostic — reusable by Fort-android) ─────────────

setup: ## Install Node dependencies for the web payload (run once after clone)
	npm ci

pyodide: ## Download Pyodide v0.29.1 runtime + crypto wheels (run once per machine)
	bash scripts/download-pyodide.sh

test-ts: ## Run TypeScript unit tests (Vitest)
	npm run test

test-e2e: ## Run Playwright E2E tests (excludes @slow Pyodide tests)
		npm run build
	npx playwright test --grep-invert "@slow"

test-e2e-slow: ## Run all E2E tests including slow Pyodide roundtrip (120s timeout)
	bash build-payload.sh
	npx playwright test

bridge-check: ## Regenerate bridge outputs and fail if tracked TS/Swift contract files drift
	npm run bridge:check

lint-ts: ## Run TypeScript type check (tsc --noEmit)
	npm run typecheck

# ── iOS-only targets ──────────────────────────────────────────────────────────

sync: ## Stage the shipped FortWeb payload into WebPayload/
	PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE) ./sync-payload.sh

sync-fortweb: ## Explicit alias for the FortWeb wrapper staging path
	PAYLOAD_SOURCE=fortweb FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE) ./sync-payload.sh

payload-contract: ## Fail closed on blocked payload regressions and validate staged WebPayload
	node tools/assert-no-proof-demo-shell.mjs
	PAYLOAD_SOURCE=fortweb FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE) ./sync-payload.sh
	node tools/validate-mobile-payload.mjs --payload-dir WebPayload --target ios-webpayload

ios-list-sims: ## List available iOS Simulator destinations
	xcrun simctl list devices available

ios-list-devices: ## List CoreDevice-visible physical devices
	xcrun devicectl list devices

require-simulator: ## Ensure the configured simulator resolves to a single available device
	@if [ -z "$(SIMULATOR_DEVICE)" ]; then \
		echo "ERROR: unable to resolve simulator '$(SIMULATOR_NAME)' (SIMULATOR_OS=$(SIMULATOR_OS))."; \
		echo "Run: make ios-list-sims"; \
		echo "Or set SIMULATOR_OS=<runtime version> / SIMULATOR_UDID=<udid>."; \
		exit 1; \
	fi

require-device-ref: ## Ensure a physical device reference is provided for install/launch targets
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required for physical-device install and launch targets."; \
		echo "Run: make ios-list-devices"; \
		echo "Then retry with DEVICE_REF=<udid-or-name>."; \
		exit 1; \
	fi

ios-doctor: ## Show Xcode, simulator, payload-source, and physical-device readiness
	@command -v xcodebuild >/dev/null || (echo "ERROR: xcodebuild not found" && exit 1)
	@command -v xcrun >/dev/null || (echo "ERROR: xcrun not found" && exit 1)
	@echo "payload-source=$(PAYLOAD_SOURCE)"
	@if [ "$(PAYLOAD_SOURCE)" = "fortweb" ]; then \
		if [ "$(FORTWEB_FETCH)" = "1" ]; then \
			command -v git >/dev/null || (echo "ERROR: git is required when FORTWEB_FETCH=1" && exit 1); \
		else \
			[ -d "$(FORTWEB_DIR)" ] || (echo "ERROR: FortWeb repo not found at $(FORTWEB_DIR)" && exit 1); \
			[ -f "$(FORTWEB_DIR)/app/index.html" ] || (echo "ERROR: FortWeb app/index.html missing" && exit 1); \
			[ -f "$(FORTWEB_DIR)/pyscript-ci.toml" ] || (echo "ERROR: FortWeb pyscript-ci.toml missing" && exit 1); \
		fi; \
	fi
	@echo "fortweb-fetch=$(FORTWEB_FETCH)"
	@echo "fortweb-ref=$(FORTWEB_REF)"
	@echo "fortweb-remote=$(FORTWEB_REMOTE)"
	@echo "simulator-name=$(SIMULATOR_NAME)"
	@echo "simulator-os=$(SIMULATOR_OS)"
	@echo "simulator-destination=$(SIMULATOR_DEST)"
	@echo "resolved-simulator-device=$(if $(SIMULATOR_DEVICE),$(SIMULATOR_DEVICE),<unresolved>)"
	@echo "physical-device-ref=$(if $(DEVICE_REF),$(DEVICE_REF),<unset>)"
	@printf '\nXcode:\n'
	@xcode-select --version
	@xcodebuild -version
	@printf '\nSDKs:\n'
	@xcrun --sdk iphoneos --show-sdk-version
	@xcrun --sdk iphonesimulator --show-sdk-version
	@printf '\nBooted simulators:\n'
	@xcrun simctl list devices booted || true
	@printf '\nPhysical devices:\n'
	@xcrun devicectl list devices || echo "warning: no physical device available via CoreDevice"

focus-sim: require-simulator ## Boot and foreground the configured Simulator target
	@xcrun simctl boot "$(SIMULATOR_DEVICE)" >/dev/null 2>&1 || true
	@bash scripts/wait-for-simulator-boot.sh "$(SIMULATOR_DEVICE)" 180
	@open -a Simulator --args -CurrentDeviceUDID "$(SIMULATOR_DEVICE)" >/dev/null 2>&1 || open -a Simulator || true
	@osascript -e 'tell application "Simulator" to activate' >/dev/null 2>&1 || true

build-sim: require-simulator ## Build KeriWallet for the resolved iOS Simulator (Debug)
	xcodebuild build \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination '$(SIMULATOR_DEST)' \
	  -derivedDataPath $(SIM_DERIVED_DATA)

install-sim: focus-sim build-sim ## Install the app onto the configured Simulator
	xcrun simctl install "$(SIMULATOR_DEVICE)" "$(SIM_APP_PATH)"

launch-sim: focus-sim install-sim ## Launch the app on the configured Simulator
	xcrun simctl launch --terminate-running-process "$(SIMULATOR_DEVICE)" $(APP_BUNDLE_ID)

build: build-sim ## Alias for simulator build

run-sim: launch-sim ## Build, install, and launch on the configured Simulator

dev-sim: sync lint-ts test-ts build-sim ## Sync payload, run TS checks, and build for Simulator

build-device: sync ## Build KeriWallet for a generic iOS device output (requires local Xcode signing)
	@xcodebuild build \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination 'generic/platform=iOS' \
	  -derivedDataPath $(DEVICE_DERIVED_DATA) \
	  -allowProvisioningUpdates || { \
		echo ""; \
		echo "ERROR: device builds require a locally configured Xcode signing account/profile."; \
		echo "Open Xcode Accounts settings, configure signing, then retry build-device/install-device/launch-device."; \
		exit 1; \
	  }

install-device: require-device-ref build-device ## Install the app on a physical device (use DEVICE_REF=<udid-or-name>)
	xcrun devicectl device install app --device "$(DEVICE_REF)" "$(DEVICE_APP_PATH)"

launch-device: require-device-ref install-device ## Launch the app on a physical device (use DEVICE_REF=<udid-or-name>)
	xcrun devicectl device process launch --device "$(DEVICE_REF)" --terminate-existing $(APP_BUNDLE_ID)

run-device: launch-device ## Build, install, and launch on a physical device (use DEVICE_REF=<udid-or-name>)

dev-device: sync lint-ts test-ts build-device ## Sync payload and build for a generic iOS device output

parity-smoke: ## Run the shared payload through simulator then device (requires DEVICE_REF)
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required"; \
		echo "Run: make ios-list-devices"; \
		exit 1; \
	fi
	xcrun simctl shutdown all || true
	$(MAKE) dev-sim PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE)
	$(MAKE) run-sim PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE)
	$(MAKE) dev-device PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE)
	$(MAKE) run-device PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) FORTWEB_FETCH=$(FORTWEB_FETCH) FORTWEB_REF=$(FORTWEB_REF) FORTWEB_REMOTE=$(FORTWEB_REMOTE) DEVICE_REF="$(DEVICE_REF)"

logs-sim: ## Show recent simulator logs for KeriWallet
	xcrun simctl spawn booted log show --style compact --last 10m --predicate 'subsystem == "com.kerifoundation.wallet" AND (category == "WebBridge" OR category == "WebContainer" OR category == "SchemeHandler" OR category == "WebNav")' | tail -n 200

logs-device: ## Relaunch on device with console attached (use DEVICE_REF=<udid-or-name>)
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required"; \
		echo "Run: make ios-list-devices"; \
		exit 1; \
	fi
	xcrun devicectl device process launch --device "$(DEVICE_REF)" --terminate-existing --console $(APP_BUNDLE_ID)

test-swift: require-simulator ## Run Swift unit + UI tests on the resolved iOS Simulator
	xcodebuild test \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination '$(SIMULATOR_DEST)' \
	  -resultBundlePath $(TEST_RESULTS) \
	  -derivedDataPath $(SIM_DERIVED_DATA) \
	  -parallel-testing-enabled NO

test-all: test-swift test-ts test-e2e ## Run Swift + TS + E2E tests

open: ## Open KeriWallet.xcodeproj in Xcode
	open $(XCODE_PROJECT)

lint: ## Run SwiftLint on all Swift sources (--strict)
	cd $(CURDIR) && swiftlint lint --config .swiftlint.yml --strict

clean: ## Remove build artifacts (DerivedData, test results, dist)
	rm -rf $(SIM_DERIVED_DATA) $(DEVICE_DERIVED_DATA) $(TEST_RESULTS) $(ARCHIVE_PATH) $(EXPORT_DIR) dist

# ── TestFlight targets ────────────────────────────────────────────────────────

archive: sync ## Archive KeriWallet for App Store (Release)
	xcodebuild archive \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Release \
	  -archivePath $(ARCHIVE_PATH) \
	  -destination 'generic/platform=iOS' \
	  -allowProvisioningUpdates

export: archive ## Export .ipa from archive using ExportOptions.plist
	@if [ ! -f $(EXPORT_OPTS) ]; then \
	  echo "ERROR: $(EXPORT_OPTS) not found — copy ExportOptions.plist.example and fill in your Team ID"; \
	  exit 1; \
	fi
	xcodebuild -exportArchive \
	  -archivePath $(ARCHIVE_PATH) \
	  -exportOptionsPlist $(EXPORT_OPTS) \
	  -exportPath $(EXPORT_DIR) \
	  -allowProvisioningUpdates

upload: export ## Upload .ipa to App Store Connect / TestFlight
	@IPA=$$(find $(EXPORT_DIR) -name '*.ipa' -print -quit); \
	if [ -z "$$IPA" ]; then echo "ERROR: no .ipa found in $(EXPORT_DIR)"; exit 1; fi; \
	echo "Uploading $$IPA to App Store Connect..."; \
	xcrun altool --upload-app -f "$$IPA" -t ios --apiKey "$$APP_STORE_API_KEY" --apiIssuer "$$APP_STORE_API_ISSUER"
