# Desktop host fixture

`thinkingEffortFixture.js` runs inside a real VS Code extension host after `npm run compile`. It activates the extension with no configured cloud project, registers no fake network transport globally, and calls a fixture dispatcher backed by an in-memory adapter. It uses real User/Workspace configuration APIs and QuickPick APIs. Run only with isolated user data, extensions and workspace paths: the fixture writes settings.

```sh
npm run compile
mkdir -p /tmp/vertex-effort-host/workspace /tmp/vertex-effort-host/extensions
env -u ELECTRON_RUN_AS_NODE \
  VERTEX_EFFORT_HOST_RESULTS=/tmp/vertex-effort-host/results.json \
  xvfb-run -a /path/to/desktop/code \
  --no-sandbox --disable-gpu --disable-workspace-trust \
  --skip-welcome --skip-release-notes --disable-updates --disable-telemetry \
  --user-data-dir /tmp/vertex-effort-host/profile \
  --extensions-dir /tmp/vertex-effort-host/extensions \
  --extensionDevelopmentPath "$PWD" \
  --extensionTestsPath "$PWD/test/host/thinkingEffortFixture.js" \
  /tmp/vertex-effort-host/workspace
```

On Linux use the actual Electron executable rather than a launcher that detaches before the virtual display lifetime ends. Repeat with the same isolated profile and `VERTEX_EFFORT_EXPECT_PERSISTED=1` to verify User persistence across a host restart. Check the JSON result, rather than relying only on the application's exit status.

The fixture validates activation, command registration, settings, direct callback resolution, canonical-only model metadata and QuickPick contracts. It does not automate the header brain icon, Palette interaction, Chat session restoration or the host's language-model RPC callback. Those require separate interactive checks. It makes no cloud inference requests and does not alter the user's regular profile.
