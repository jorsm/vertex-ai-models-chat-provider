# Live acceptance and release gate

`npm run test:live` installs a packaged VSIX into an isolated VS Code instance and exercises Gemini and Claude through the public `vscode.lm` API against real Vertex endpoints. Both providers are required: six checks must pass, with no skipped cases, substitute models or fallback providers. An unavailable model or failed check produces a nonzero exit code; the report retains any partial successes.

The updated GitHub publication workflows require the offline suite and these six live checks. Each packages one VSIX before cloud authentication, tests its installed extension, verifies the report and artifact hash, and publishes those same bytes. Missing CI configuration, unavailable models, failed or skipped checks, stale reports and modified packages block publication on refs containing those workflows. Grok is outside the mandatory acceptance scope.

## Rollout status and cutover

As verified on **11 October 2026**, [PR #16](https://github.com/jorsm/vertex-ai-models-chat-provider/pull/16) is a draft targeting `develop`. The repository's stable branch is `main`; there is no `master` branch. The live gate has not been merged into either release branch.

| Ref                           | Current release behavior                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                        | Existing stable tag/manual release flow, using repository `VSCE_PAT`; no mandatory live ADC checks.                                           |
| `develop`                     | Existing manual prerelease flow and stable workflow, using repository `VSCE_PAT`; no mandatory live ADC checks.                               |
| `codex/live-adc-release-gate` | Updated stable/prerelease workflows require all six live checks. GitHub validation currently stops because the CI identity is not configured. |

The repository `VSCE_PAT` is deliberately retained during preparation, so the old release flow remains available. Creating `marketplace-release` and adding the private project secret does not enforce the gate on `main`, `develop` or historical tags. There is currently no repository-wide guarantee that publication has passed live ADC checks.

The environment exists, but its Marketplace token has not been added. `VERTEX_LIVE_PROJECT_ID` is configured; `VERTEX_LIVE_WIF_PROVIDER` and `VERTEX_LIVE_SERVICE_ACCOUNT` are missing. The local account cannot create the WIF pool/custom role or grant the required IAM bindings, so no partial cloud resources were created. A project administrator must run the [cloud setup commands](github-live-setup.md).

All six real checks passed locally through a packaged prerelease VSIX, including the CI-mode runner and artifact guard. [GitHub offline CI passed](https://github.com/jorsm/vertex-ai-models-chat-provider/actions/runs/38177646746). The [GitHub prerelease verification](https://github.com/jorsm/vertex-ai-models-chat-provider/actions/runs/38177663748) passed packaging and manifest checks, then failed at missing CI configuration before authentication or publication. That run does not validate the dedicated GitHub ADC identity.

Use this staged rollout:

1. Have a project administrator configure WIF and the dedicated service account, then inject the missing repository identifiers. Keep the repository Marketplace token during preparation.
2. Add `VSCE_PAT` to `marketplace-release` using the [token staging command](github-live-setup.md#stage-the-marketplace-token-in-the-release-environment). Retain its repository-level copy so existing release branches continue to work.
3. Dispatch the updated prerelease workflow on the PR branch with `verify_only=true`. Require all six real checks to pass using the dedicated CI ADC identity. This run does not publish and needs no Marketplace token.
4. At the planned cutover, finish or cancel queued and running legacy publication jobs and pause new release dispatches/tag pushes. Merge PR #16 into `develop`, then promote the same gate files to `main`. Confirm both branches contain the workflows, shared action, runner/guard scripts and dependency changes, and that their offline CI passes.
5. Verify the environment Marketplace token exists, then [remove the repository-level copy](github-live-setup.md#complete-the-token-cutover). Updated jobs use the environment token; historical workflows without that environment lose access to publishing credentials.
6. Resume releases using refs containing the gate. Every stable/prerelease release repeats the live checks and verifies its own report and VSIX hash; earlier green runs cannot authorize a later package.

For preparation step 3, select the PR branch explicitly; the current `main` and `develop` workflows do not support `verify_only`:

```sh
gh workflow run publish-prerelease.yml \
  --repo OWNER/REPO \
  --ref codex/live-adc-release-gate \
  -f verify_only=true
```

Treat the cutover as complete only after the dedicated GitHub ADC run passes, both release branches contain the gate, the environment token is present, the repository token is removed and no queued or running legacy publication jobs remain. Update this status section when that happens. Until then, `main` and `develop` retain the old flow.

## Run it

Use a project and credential identity that already have access to the selected models. The runner does not enable cloud services or change IAM. Install the repository dependencies first:

```sh
npm ci
npm run test:live -- --project YOUR_PROJECT_ID
```

For repeated runs, copy [`.env.example`](../.env.example) to `.env` once, then edit that local file. It is excluded from Git and the VSIX and loaded automatically. With a configured project, run:

```sh
npm run test:live
```

Configuration precedence is defaults, then `.env`, then the process environment, then explicit command-line flags. `--env-file /path/to/file` selects another dotenv file. Node's dotenv parser handles quotes and comments; shell variables such as `$HOME` are not expanded, so use an absolute credential-file path. The default request timeout is 90 seconds; the overall host timeout is 900 seconds.

Use `VERTEX_LIVE_PROJECT_ID`, `VERTEX_LIVE_EXPECTED_ACCOUNT`, optional `VERTEX_LIVE_ADC_FILE`, `VERTEX_LIVE_REGION`, `VERTEX_LIVE_GEMINI_MODEL`, `VERTEX_LIVE_CLAUDE_MODEL`, `VERTEX_LIVE_REQUEST_TIMEOUT_SECONDS`, `VERTEX_LIVE_HOST_TIMEOUT_SECONDS` and `VERTEX_LIVE_VSCODE_VERSION`. Optional `VERTEX_LIVE_VSCODE_EXECUTABLE`, `VERTEX_LIVE_VSIX` and `VERTEX_LIVE_REPORT_PATH` select existing executables/artifacts and the report destination. The previous `.vscode-test/live/config.json` is no longer read.

The default models are `gemini-3.8-flash` and `claude-haiku-5-5`, in `global`. Both can be changed independently in the environment or with explicit flags.

To choose an existing credential file explicitly:

```sh
npm run test:live -- \
  --project YOUR_PROJECT_ID \
  --adc-file /absolute/path/to/credentials.json
```

If you need to create local user ADC, Google's documented setup command is:

```sh
gcloud auth application-default login
```

This creates or replaces the local ADC file, so select the intended account. `--adc-file` takes priority locally; otherwise the runner uses `VERTEX_LIVE_ADC_FILE`, `GOOGLE_APPLICATION_CREDENTIALS` or the SDK's ambient ADC lookup. Injected `GOOGLE_APPLICATION_CREDENTIALS` overrides a lower-priority `.env` credential path. An active `gcloud auth login` account does not establish which identity the SDK uses. A separate gcloud CLI configuration alone does not select a separate ADC identity. See [Google's local ADC setup](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment) and [ADC configuration](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc).

Set `VERTEX_LIVE_EXPECTED_ACCOUNT` or pass `--expected-account YOUR_EMAIL` to check the ADC identity before inference. A missing identity email or mismatch fails the run. Tokens are inspected in memory. The selected project is also supplied as the child's quota project.

If existing ADC lacks the email scope, create separate test credentials without replacing existing credentials on Linux/macOS:

```sh
CLOUDSDK_CONFIG="$HOME/.config/gcloud-vertex-live" \
  gcloud auth application-default login YOUR_EMAIL \
  --project=YOUR_PROJECT_ID \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform
```

Then set `VERTEX_LIVE_ADC_FILE` to the absolute path of `$HOME/.config/gcloud-vertex-live/application_default_credentials.json` in `.env`. The CLI writes into its separate config directory; the Node SDK needs the explicit file path to select these credentials. Choose a different config directory when creating credentials for another account. This preserves an existing ADC file that may have additional scopes such as Drive. Google documents [config directory overrides](https://docs.cloud.google.com/sdk/docs/configurations) and the [login scope option](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login).

Available options:

| Option                                      | Purpose                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `--project ID`                              | Required Vertex project, unless set in the environment.       |
| `--env-file /path/to/file`                  | Select a local dotenv file.                                   |
| `--expected-account EMAIL`                  | Require the ADC identity to match this email.                 |
| `--adc-file /absolute/file.json`            | Use an existing credential file in place.                     |
| `--gemini-model ID`                         | Select a Gemini model from the packaged catalog.              |
| `--claude-model ID`                         | Select a Claude model from the packaged catalog.              |
| `--region REGION`                           | Select the test region; defaults to `global`.                 |
| `--vscode-version VERSION`                  | Select the downloaded VS Code version, for example `1.110.0`. |
| `--vscode-executable /actual/electron/path` | Use an existing desktop Electron executable.                  |
| `--vsix /path/to/extension.vsix`            | Test an existing package instead of building one.             |
| `--report /path/to/report.json`             | Choose the JSON report destination.                           |

On Linux, the runner uses `xvfb-run -a` automatically when `DISPLAY` is absent; install your distribution's `xvfb` package for that case. Use the actual Electron executable for `--vscode-executable`, rather than a launcher that detaches. VS Code documents its [extension test runner](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and [headless CI setup](https://code.visualstudio.com/api/working-with-extensions/continuous-integration).

## What it verifies

For each selected provider, the harness checks:

1. A streamed text response through public model selection and `sendRequest`.
2. Image interpretation using a generated PNG with five colors in randomized order.
3. The requested tool name and arguments, followed by a continuation that returns a random receipt supplied only in the tool result.

The product is installed from the same VSIX that the report identifies. Its repository source modules are not imported by the host harness. The runner creates temporary profile, extensions and workspace directories; it leaves regular VS Code settings alone. Before configuring the cloud project, it uses the installed extension's catalog command to seed a workspace catalog, then retains the two selected definitions with a 2,048-token output cap. Catalog default efforts are preserved.

Requests are billable, including discovery probes. The output cap applies to each inference request, not the entire run; tool continuation needs an additional request. Thinking and other provider-accounted tokens can also contribute to cost.

## Results and boundaries

The default report is `.vscode-test/live/latest.json`; the packaged artifact is retained beside it as `artifact.vsix`. The report records the VSIX hash, checkout SHA and dirty state, host version, and individual check outcomes. When supplying `--vsix`, checkout metadata describes the current repository and does not prove that package's source provenance; its hash identifies the executable artifact tested.

Credential files are used in place and never copied into the test workspace or package. Endpoint override environment variables are stripped. Raw host logs stay in private temporary storage: do not upload them. GitHub uses Workload Identity Federation through a dedicated service account; it generates temporary ADC without uploading local human credentials or exporting a service-account key.

## GitHub setup

Add the following repository secrets under **Settings → Secrets and variables → Actions**. These are identifiers, not credential files; storing them as secrets also keeps them out of public workflow logs.

| Secret                        | Value                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `VERTEX_LIVE_PROJECT_ID`      | Google Cloud project with billing, the Vertex API and access to both selected models.                         |
| `VERTEX_LIVE_WIF_PROVIDER`    | Full provider name: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER`. |
| `VERTEX_LIVE_SERVICE_ACCOUNT` | Dedicated CI service-account email. This is also the expected ADC identity.                                   |

Create the `marketplace-release` environment under **Settings → Environments** and store `VSCE_PAT` there as an environment secret. Both updated publication jobs reference this environment; the token is passed only to the publication step. Stage the environment token during preparation and keep the repository-level copy until the [planned cutover](#rollout-status-and-cutover). The [setup commands](github-live-setup.md#stage-the-marketplace-token-in-the-release-environment) separate staging from removal and avoid printing or saving the token locally. Keep the three live-test identity identifiers above as repository secrets. See [GitHub's environment documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Optional repository variables select models and runtime. Defaults are `VERTEX_LIVE_GEMINI_MODEL=gemini-3.8-flash`, `VERTEX_LIVE_CLAUDE_MODEL=claude-haiku-5-5`, `VERTEX_LIVE_REGION=global`, and `VERTEX_LIVE_VSCODE_VERSION=1.110.0`. Model overrides must be supported IDs in the packaged catalog. Do not add `VERTEX_LIVE_ADC_FILE` in CI: the authentication action exports `GOOGLE_APPLICATION_CREDENTIALS`. Conflicting overrides fail before requests. The runner ignores the repository `.env` in CI, and the release action never passes `--env-file`.

The shared [release action](../.github/actions/live-release-gate/action.yml) downloads the pinned desktop host before authentication, then uses `google-github-actions/auth@v3` to create ADC through service-account impersonation. Google documents [the auth action](https://github.com/google-github-actions/auth) and [Workload Identity Federation for deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines). See [cloud setup commands](github-live-setup.md) to create the dedicated identity and trust configuration.

Commit the workflows, shared action and scripts on the ref being released. Local actions are loaded from that checkout, so manual runs of the updated workflow need those files on the selected release ref. A tag push at an older commit can load its historical workflow without the live gate. Moving `VSCE_PAT` into `marketplace-release` and removing its repository-level copy prevents those historical jobs, which do not reference the environment, from publishing. Stable publication accepts a `vMAJOR.MINOR.PATCH` tag and checks it matches `package.json`. Prerelease manual runs preserve the selected branch/ref.

For the first GitHub validation, dispatch **Publish Pre-Release to VS Marketplace** on the updated ref and enable **Run all release checks without publishing** (`verify_only=true`). This executes packaging, WIF authentication and all six live checks, then skips publication. It needs no Marketplace token. A green local run does not prove the dedicated CI identity works; the first successful GitHub validation establishes that path.

For ordinary runs of the updated release workflows, leave `verify_only=false`. Those workflows have no option to skip live tests. Both check the current GitHub run/attempt, checkout SHA, verified ADC identity and complete result matrix. Immediately before publication, the guard compares the VSIX SHA256 with the passing report. Stable publish retries recheck the hash before every attempt; neither workflow rebuilds during publication.

The saved CI report redacts project ID, expected/verified account and credential path, and only that JSON report is uploaded as an artifact. Local reports retain these details in ignored files. Raw host logs, ADC files, `.env` and the complete `.vscode-test` directory are never uploaded. See [GitHub's secrets documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

A passing run establishes the selected models and scoped test catalog. It does not establish every shipped model's availability, full-catalog discovery, personal authentication/login UX, the complete Chat UI, remote extension hosts or enterprise proxy behavior. Changing model IDs, region, credentials, VS Code version or the VSIX changes what the result establishes.
