.DEFAULT_GOAL := help

XCODE_PROJECT := KeriWallet.xcodeproj
SCHEME        := KeriWallet
APP_BUNDLE_ID := com.kerifoundation.wallet
PAYLOAD_SOURCE ?= fortweb
FORTWEB_DIR   ?= ../fortweb

# ── Simulator resolution ─────────────────────────────────────────────────────
# Resolve a single simulator UDID.  Precedence:
#   SIMULATOR_UDID           → use that exact device
#   SIMULATOR_NAME ± SIMULATOR_OS → match by name, optionally constrained by OS
#   single booted iPhone     → auto-select
#   newest runtime           → preferred model fallback
SIMULATOR_UDID  ?=
SIMULATOR_NAME ?=
SIMULATOR_OS   ?=
SIM_UDID       := $(shell \
	export SIMULATOR_UDID="$(SIMULATOR_UDID)" \
	       SIMULATOR_NAME="$(SIMULATOR_NAME)" \
	       SIMULATOR_OS="$(SIMULATOR_OS)" && \
	python3 scripts/resolve-ios-simulator.py --udid 2>/dev/null || echo "SIM_UNRESOLVED")
SIM_DESTINATION := platform=iOS Simulator,id=$(SIM_UDID)

SIM_DERIVED_DATA := build/DerivedData-sim
DEVICE_DERIVED_DATA := build/DerivedData-device
TEST_RESULTS  := build/TestResults.xcresult
ARCHIVE_PATH  := build/KeriWallet.xcarchive
EXPORT_DIR    := build/export
EXPORT_OPTS   := ExportOptions.plist
SIM_APP_PATH  := $(SIM_DERIVED_DATA)/Build/Products/Debug-iphonesimulator/KeriWallet.app
DEVICE_APP_PATH := $(DEVICE_DERIVED_DATA)/Build/Products/Debug-iphoneos/KeriWallet.app
DEVICE_REF    ?=

# FortWeb-driven Xcode preparation
XCODE_READY_TESTS ?= 1

.PHONY: help setup pyodide sync sync-fortweb payload-contract ios-doctor ios-resolve-sim ios-list-sims ios-list-devices xcode-ready dev-sim run-sim dev-device run-device parity-smoke logs-sim logs-device build test-swift test-ts test-e2e test-e2e-slow test-all bridge-check lint lint-ts open clean clean-payload clean-runtime clean-all doctor archive export upload

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
	npm run build
	npx playwright test

bridge-check: ## Verify bridge-contract.ts, BridgeContract.swift, and BridgeContract.kt are up to date
	npm run bridge:check

lint-ts: ## Run TypeScript type check (tsc --noEmit)
	npm run typecheck

# ── iOS-only targets ──────────────────────────────────────────────────────────

sync: ## Stage the shipped FortWeb payload into WebPayload/
	PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) ./sync-payload.sh

sync-fortweb: ## Explicit alias for the FortWeb wrapper staging path
	PAYLOAD_SOURCE=fortweb FORTWEB_DIR=$(FORTWEB_DIR) ./sync-payload.sh

payload-contract: ## Fail closed on blocked payload regressions and validate staged WebPayload
	node tools/assert-no-proof-demo-shell.mjs
	PAYLOAD_SOURCE=fortweb FORTWEB_DIR=$(FORTWEB_DIR) ./sync-payload.sh
	node tools/validate-mobile-payload.mjs --payload-dir WebPayload --target ios-webpayload

ios-list-sims: ## List available iOS Simulator destinations
	xcrun simctl list devices available

ios-list-devices: ## List CoreDevice-visible physical devices
	xcrun devicectl list devices

ios-resolve-sim: ## Print resolved simulator information
	@SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	  python3 scripts/resolve-ios-simulator.py

ios-doctor: ## Verify Xcode, simulator, and payload-source readiness
	@command -v xcodebuild >/dev/null || (echo "ERROR: xcodebuild not found" && exit 1)
	@command -v xcrun >/dev/null || (echo "ERROR: xcrun not found" && exit 1)
	@echo "developer-dir=$${DEVELOPER_DIR:-not set}"
	@xcodebuild -version 2>/dev/null | sed 's/^/xcode-/'
	@echo "ios-sdk-version=$$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null || echo unknown)"
	@echo "deployment-target=$$(xcodebuild -project $(XCODE_PROJECT) -showBuildSettings 2>/dev/null | awk '/IPHONEOS_DEPLOYMENT_TARGET/ {print $$3}' | head -1)"
	@echo "swift-version=$$(xcrun swift --version 2>/dev/null | head -1 || echo unknown)"
	@echo "fortweb-dir=$(FORTWEB_DIR)"
	@echo "payload-present=$$([ -d WebPayload/fortweb ] && echo yes || echo no)"
	@echo "payload-valid=$$([ -f WebPayload/build-manifest.json ] && echo yes || echo no)"
	@if [ -f WebPayload/build-manifest.json ]; then \
	  python3 -c "import json; m=json.load(open('WebPayload/build-manifest.json')); print('payload-producer='+m.get('producer','unknown')); print('payload-git-sha='+m.get('git_sha',m.get('dist_tree_sha256','unknown'))[:16])" 2>/dev/null || true; \
	fi
	@if [ "$$(SIMULATOR_UDID)" != "" ] || [ "$$(SIMULATOR_NAME)" != "" ] || [ "$$(SIMULATOR_OS)" != "" ]; then \
	  echo "INFO: Using explicit simulator override"; \
	  SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	    python3 scripts/resolve-ios-simulator.py; \
	else \
	  echo "INFO: Auto-resolving simulator (set SIMULATOR_NAME, SIMULATOR_OS, or SIMULATOR_UDID to override)"; \
	  SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	    python3 scripts/resolve-ios-simulator.py; \
	fi
	@xcrun devicectl list devices >/dev/null 2>&1 || echo "WARNING: no physical device available via CoreDevice"
	@if [ ! -d WebPayload/fortweb ]; then \
	  echo "ERROR: WebPayload is missing."; \
	  echo "Run: make xcode-ready FORTWEB_DIR=../FortWeb"; \
	fi

xcode-ready: ## Prepare the repository for opening in Xcode (press Play after)
	@command -v xcodebuild >/dev/null || (echo "ERROR: xcodebuild not found. Install Xcode." && exit 1)
	@command -v npm >/dev/null || (echo "ERROR: npm not found." && exit 1)
	@if [ ! -d node_modules ]; then echo "ERROR: node_modules is missing."; echo "Run: npm ci"; exit 1; fi
	@echo "=== Resolving simulator ==="
	@SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	  python3 scripts/resolve-ios-simulator.py || (echo "ERROR: No compatible iPhone Simulator is installed."; echo "Open Xcode > Settings > Components and install an iOS Simulator runtime."; exit 1)
	@echo ""
	@echo "=== Syncing payload ==="
	@if [ -d WebPayload/fortweb ]; then \
	  echo "Payload already staged. Use FORTWEB_DIR to re-sync if needed."; \
	else \
	  PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) ./sync-payload.sh; \
	fi
	@echo ""
	@echo "=== Validating payload ==="
	@node tools/validate-mobile-payload.mjs --payload-dir WebPayload --target ios-webpayload
	@echo ""
	@echo "=== Checking bridge contract ==="
	@npm run bridge:check
	@echo ""
	@echo "=== TypeScript type checking ==="
	@npm run typecheck
	@if [ "$(XCODE_READY_TESTS)" = "1" ]; then \
	  echo ""; \
	  echo "=== Running TypeScript unit tests ==="; \
	  npm run test; \
	fi
	@echo ""
	@echo "=== Ready ==="
	@echo "Project: $(XCODE_PROJECT)"
	@echo "Open with: make open"
	@SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	  python3 scripts/resolve-ios-simulator.py 2>/dev/null || true

dev-sim: sync lint-ts test-ts build ## Sync payload, run TS checks, and build for Simulator

run-sim: ## Boot, install, and launch on the resolved Simulator
	@if [ "$(SIM_UDID)" = "SIM_UNRESOLVED" ]; then \
	  echo "ERROR: Could not resolve a simulator."; \
	  echo "Run: make ios-resolve-sim"; \
	  exit 1; \
	fi
	open -a Simulator || true
	xcrun simctl boot "$(SIM_UDID)" || true
	xcrun simctl bootstatus "$(SIM_UDID)" -b
	xcrun simctl install "$(SIM_UDID)" "$(SIM_APP_PATH)"
	xcrun simctl launch "$(SIM_UDID)" $(APP_BUNDLE_ID)

dev-device: sync ## Sync payload and build for a generic iOS device output
	xcodebuild build \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination 'generic/platform=iOS' \
	  -derivedDataPath $(DEVICE_DERIVED_DATA)

run-device: ## Install and launch on a physical device (use DEVICE_REF=<udid-or-name>)
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required"; \
		echo "Run: make ios-list-devices"; \
		exit 1; \
	fi
	xcrun devicectl device install app --device "$(DEVICE_REF)" "$(DEVICE_APP_PATH)"
	xcrun devicectl device process launch --device "$(DEVICE_REF)" --terminate-existing $(APP_BUNDLE_ID)

parity-smoke: ## Run the shared payload through simulator then device (requires DEVICE_REF)
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required"; \
		echo "Run: make ios-list-devices"; \
		exit 1; \
	fi
	@if [ "$(SIM_UDID)" = "SIM_UNRESOLVED" ]; then \
	  echo "ERROR: Could not resolve a simulator."; \
	  exit 1; \
	fi
	$(MAKE) dev-sim PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR)
	$(MAKE) run-sim PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR)
	$(MAKE) dev-device PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR)
	$(MAKE) run-device PAYLOAD_SOURCE=$(PAYLOAD_SOURCE) FORTWEB_DIR=$(FORTWEB_DIR) DEVICE_REF="$(DEVICE_REF)"

logs-sim: ## Show recent simulator logs for KeriWallet
	@if [ "$(SIM_UDID)" = "SIM_UNRESOLVED" ]; then \
	  echo "ERROR: Could not resolve a simulator."; \
	  exit 1; \
	fi
	xcrun simctl spawn "$(SIM_UDID)" log show --style compact --last 10m --predicate 'subsystem == "com.kerifoundation.wallet" AND (category == "WebBridge" OR category == "WebContainer" OR category == "SchemeHandler" OR category == "WebNav")' | tail -n 200

logs-device: ## Relaunch on device with console attached (use DEVICE_REF=<udid-or-name>)
	@if [ -z "$(DEVICE_REF)" ]; then \
		echo "ERROR: DEVICE_REF is required"; \
		echo "Run: make ios-list-devices"; \
		exit 1; \
	fi
	xcrun devicectl device process launch --device "$(DEVICE_REF)" --terminate-existing --console $(APP_BUNDLE_ID)

build: ## Build KeriWallet for iOS Simulator (Debug)
	@if [ "$(SIM_UDID)" = "SIM_UNRESOLVED" ]; then \
	  echo "ERROR: Could not resolve a simulator."; \
	  exit 1; \
	fi
	xcodebuild build \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination '$(SIM_DESTINATION)' \
	  -derivedDataPath $(SIM_DERIVED_DATA)

test-swift: ## Run Swift unit + UI tests on iOS Simulator
	@if [ "$(SIM_UDID)" = "SIM_UNRESOLVED" ]; then \
	  echo "ERROR: Could not resolve a simulator."; \
	  exit 1; \
	fi
	xcodebuild test \
	  -project $(XCODE_PROJECT) \
	  -scheme $(SCHEME) \
	  -configuration Debug \
	  -destination '$(SIM_DESTINATION)' \
	  -resultBundlePath $(TEST_RESULTS) \
	  -derivedDataPath $(SIM_DERIVED_DATA) \
	  -parallel-testing-enabled NO

test-all: test-swift test-ts test-e2e ## Run Swift + TS + E2E tests

open: ## Open KeriWallet.xcodeproj in Xcode
	open $(XCODE_PROJECT)

lint: ## Run SwiftLint on all Swift sources (--strict)
	cd $(CURDIR) && swiftlint lint --config .swiftlint.yml --strict

# ── Cleanup targets ───────────────────────────────────────────────────────────

clean: ## Remove build artifacts, caches, and temporary output (safe daily cleanup)
	rm -rf $(SIM_DERIVED_DATA) $(DEVICE_DERIVED_DATA) $(TEST_RESULTS) $(ARCHIVE_PATH) $(EXPORT_DIR) dist
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name '*.pyc' -delete 2>/dev/null || true
	find . -type f -name '.DS_Store' -delete 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	rm -rf test-results

clean-payload: ## Remove staged mobile payload (regenerate with make xcode-ready)
	@echo "Removing WebPayload/ ..."
	rm -rf WebPayload
	@echo "Regenerate: make xcode-ready FORTWEB_DIR=../FortWeb"

clean-runtime: ## Remove downloaded Pyodide runtime (regenerate with make pyodide)
	@echo "Removing public/pyodide/ ..."
	rm -rf public/pyodide
	@echo "Regenerate: make pyodide"

clean-all: clean clean-payload clean-runtime ## Full developer reset (preserves source, .git, node_modules)

# ── Diagnostics ───────────────────────────────────────────────────────────────

doctor: ## Report environment state without mutation
	@echo "=== Xcode ==="
	@command -v xcodebuild >/dev/null && xcodebuild -version 2>/dev/null || echo "  not found"
	@echo "iOS SDK: $$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null || echo unknown)"
	@echo "Swift: $$(xcrun swift --version 2>/dev/null | head -1 || echo unknown)"
	@echo "Deployment target: $$(xcodebuild -project $(XCODE_PROJECT) -showBuildSettings 2>/dev/null | awk '/IPHONEOS_DEPLOYMENT_TARGET/ {print $$3}' | head -1)"
	@echo ""
	@echo "=== Simulator ==="
	@SIMULATOR_UDID="$(SIMULATOR_UDID)" SIMULATOR_NAME="$(SIMULATOR_NAME)" SIMULATOR_OS="$(SIMULATOR_OS)" \
	  python3 scripts/resolve-ios-simulator.py 2>/dev/null || echo "  No compatible simulator found"
	@echo ""
	@echo "=== FortWeb ==="
	@echo "FORTWEB_DIR: $(FORTWEB_DIR)"
	@echo "Payload present: $$([ -d WebPayload/fortweb ] && echo yes || echo no)"
	@echo "Payload valid: $$(node tools/validate-mobile-payload.mjs --payload-dir WebPayload --target ios-webpayload 2>/dev/null | grep result || echo unknown)"
	@echo ""
	@echo "=== TypeScript ==="
	@echo "Node: $$(node --version 2>/dev/null || echo unknown)"
	@echo "npm: $$(npm --version 2>/dev/null || echo unknown)"
	@echo "Bridge: $$(node tools/gen-bridge-contract.mjs --check 2>/dev/null | tail -1 || echo unknown)"
	@echo ""
	@echo "=== SwiftLint ==="
	@command -v swiftlint >/dev/null && swiftlint version 2>/dev/null || echo "  not installed"
	@echo ""
	@echo "=== Pyodide ==="
	@echo "Pyodide present: $$([ -d public/pyodide ] && echo yes || echo 'no (run make pyodide)')"
	@echo ""
	@echo "=== Git ==="
	@echo "Branch: $$(git branch --show-current 2>/dev/null)"
	@echo "Dirty: $$(git status --short 2>/dev/null | grep -v '^??' | head -5 || echo clean)"

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
