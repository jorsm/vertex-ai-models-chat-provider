#!/usr/bin/env bash
set -euo pipefail
proxy_test_repo="$(cd "$(dirname "$0")/.." && pwd)"
proxy_test_url="${1:-http://127.0.0.1:18081}"
proxy_test_root="$(mktemp -d /tmp/vertex-proxy-vscode.XXXXXX)"
mkdir -p "$proxy_test_root/user-data/User" "$proxy_test_root/extensions" "$proxy_test_root/workspace/.vscode"
node - "$proxy_test_root" "$proxy_test_url" <<'JS'
const fs=require('node:fs');
const [root,url]=process.argv.slice(2);
fs.writeFileSync(root+'/user-data/User/settings.json',JSON.stringify({'vertexAiChat.proxyUrl':url,'vertexAiChat.projectId':process.env.VERTEX_PROJECT_ID||'local-proxy-project','vertexAiChat.enableUserLabel':false,'vertexAiChat.enableProjectLabel':true,'security.workspace.trust.enabled':false,'telemetry.telemetryLevel':'off','extensions.autoUpdate':false,'window.dialogStyle':'custom'}));
fs.writeFileSync(root+'/workspace/.vscode/settings.json',JSON.stringify({'vertexAiChat.projectLabelValue':'local-proxy-vscode-test'}));
JS
git -C "$proxy_test_root/workspace" init -q
git -C "$proxy_test_root/workspace" -c user.name='Local Proxy Test' -c user.email='test@example.invalid' commit --allow-empty -q -m 'Initialize isolated test repository'
cd "$proxy_test_repo"
npm run bundle
export PROXY_TEST_URL="$proxy_test_url"
export PROXY_TEST_RESULT="$proxy_test_root/result.json"
export PROXY_TEST_USER_DATA="$proxy_test_root/user-data"
printf 'Isolated VS Code test results: %s\n' "$PROXY_TEST_RESULT"
code --new-window --wait --disable-gpu --skip-welcome --skip-release-notes --disable-workspace-trust \
  --user-data-dir "$proxy_test_root/user-data" --extensions-dir "$proxy_test_root/extensions" \
  --extensionDevelopmentPath="$proxy_test_repo" \
  --extensionTestsPath="$proxy_test_repo/scripts/test-local-proxy-extension-host.cjs" "$proxy_test_root/workspace"
cat "$PROXY_TEST_RESULT"
node -e 'if(!require(process.env.PROXY_TEST_RESULT).ok) process.exit(1)'
