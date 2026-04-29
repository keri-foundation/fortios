#!/usr/bin/env bash
set -euo pipefail

echo "error: build-payload.sh is retired for live wrapper staging" 1>&2
echo "       The iOS wrapper now stages only the shared FortWeb bundle via ./sync-payload.sh or 'make sync'." 1>&2
echo "       Local dist-producing proof-shell flows are being removed from Fort-ios and should not be used as wrapper inputs." 1>&2
echo "       If you need the remaining browser-only validation lane, use the explicit npm or Playwright commands instead." 1>&2
exit 1
