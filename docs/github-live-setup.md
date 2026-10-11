# Google Cloud identity for GitHub live tests

Use a dedicated service account with Workload Identity Federation (WIF). GitHub creates temporary ADC for the release job; local user ADC and service-account keys are not uploaded. If you already have a suitable identity/provider, set the three repository secrets in [live acceptance](live-acceptance.md#github-setup) and skip creation.

This is a staged rollout. [Current status and cutover order](live-acceptance.md#rollout-status-and-cutover) explain which refs have the gate and which still support the old release flow. Keep the repository `VSCE_PAT` during preparation. Adding cloud identifiers or creating the release environment alone does not gate existing workflows.

These one-time commands create the identity and IAM bindings in the project you choose. Run them with a Google Cloud account authorized to administer that project. Billing, the Vertex API, quota and the selected Claude model's Model Garden access/terms must be available in that project. The CI service account only needs inference and quota-project usage permissions; it does not enable models or administer the project. Google documents [inference permissions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control) and [quota-project permissions](https://docs.cloud.google.com/docs/quotas/set-quota-project).

## Select the project and repository

Replace the placeholders. `gh` must be authenticated to the intended GitHub repository; these API calls read its immutable numeric identity.

```sh
LIVE_PROJECT_ID=YOUR_GOOGLE_CLOUD_PROJECT_ID
LIVE_GITHUB_REPOSITORY=OWNER/REPO
LIVE_REPOSITORY_ID=$(gh api "repos/${LIVE_GITHUB_REPOSITORY}" --jq '.id')
LIVE_OWNER_ID=$(gh api "repos/${LIVE_GITHUB_REPOSITORY}" --jq '.owner.id')
LIVE_SERVICE_ACCOUNT="vertex-release-live@${LIVE_PROJECT_ID}.iam.gserviceaccount.com"
```

## Create the CI identity

```sh
gcloud services enable \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  aiplatform.googleapis.com \
  --project="$LIVE_PROJECT_ID"

gcloud iam service-accounts create vertex-release-live \
  --project="$LIVE_PROJECT_ID" \
  --display-name="Vertex extension live acceptance"

gcloud iam roles create vertexReleaseLive \
  --project="$LIVE_PROJECT_ID" \
  --title="Vertex release live inference" \
  --permissions=aiplatform.endpoints.predict,serviceusage.services.use \
  --stage=GA

gcloud projects add-iam-policy-binding "$LIVE_PROJECT_ID" \
  --member="serviceAccount:${LIVE_SERVICE_ACCOUNT}" \
  --role="projects/${LIVE_PROJECT_ID}/roles/vertexReleaseLive"

gcloud iam workload-identity-pools create vertex-release \
  --project="$LIVE_PROJECT_ID" \
  --location=global \
  --display-name="Vertex extension release workflows"
```

## Trust only this repository's publication workflows

The provider restricts numeric repository/owner IDs, workflow file and event/ref. It accepts stable version-tag pushes and manual stable/prerelease runs on the selected branch. Pull requests and other workflow files cannot authenticate through this provider. Stable manual `source_ref` selects the checkout tag, while the OIDC `ref` remains the branch used to dispatch the workflow; the stable pipeline independently validates the tag and extension version.

```sh
LIVE_WIF_CONDITION="assertion.repository_id == '${LIVE_REPOSITORY_ID}' &&
assertion.repository_owner_id == '${LIVE_OWNER_ID}' &&
((assertion.workflow_ref.startsWith('${LIVE_GITHUB_REPOSITORY}/.github/workflows/publish.yml@') &&
  ((assertion.event_name == 'push' && assertion.ref.startsWith('refs/tags/v')) ||
   (assertion.event_name == 'workflow_dispatch' && assertion.ref.startsWith('refs/heads/')))) ||
 (assertion.workflow_ref.startsWith('${LIVE_GITHUB_REPOSITORY}/.github/workflows/publish-prerelease.yml@') &&
  assertion.event_name == 'workflow_dispatch' && assertion.ref.startsWith('refs/heads/')))"

gcloud iam workload-identity-pools providers create-oidc github \
  --project="$LIVE_PROJECT_ID" \
  --location=global \
  --workload-identity-pool=vertex-release \
  --display-name="Vertex GitHub publication workflows" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition="$LIVE_WIF_CONDITION"

LIVE_WIF_POOL=$(gcloud iam workload-identity-pools describe vertex-release \
  --project="$LIVE_PROJECT_ID" --location=global --format='value(name)')

gcloud iam service-accounts add-iam-policy-binding "$LIVE_SERVICE_ACCOUNT" \
  --project="$LIVE_PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${LIVE_WIF_POOL}/attribute.repository_id/${LIVE_REPOSITORY_ID}"

LIVE_WIF_PROVIDER=$(gcloud iam workload-identity-pools providers describe github \
  --project="$LIVE_PROJECT_ID" --location=global \
  --workload-identity-pool=vertex-release --format='value(name)')
```

The service account grants token impersonation to that restricted pool; ordinary WIF impersonation needs no service-account key or self-granted Token Creator role. See Google's [WIF configuration guide](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), the [auth action setup](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account) and [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

Both updated release jobs use the `marketplace-release` environment. This changes the OIDC subject (`sub`) to include the environment; the provider above authorizes immutable repository/owner IDs, `ref`, event and `workflow_ref`, and its IAM binding uses the repository ID. Neither rule requires a literal `sub` value, so this environment change needs no WIF configuration change. Adapt an existing provider if it instead authorizes a specific `sub` value.

## Stage the Marketplace token in the release environment

Create `marketplace-release` under **Settings → Environments** in the repository if it does not already exist. Allow the intended release tags and prerelease branches in its deployment rules. Add the token there during preparation and keep its repository-level copy so the current release branches can still publish. The three live-test identity identifiers stay as repository secrets.

Run this command in an interactive terminal and paste the token at the prompt. Do not put the token in command arguments, a shell variable or a local file:

```sh
gh secret set VSCE_PAT --env marketplace-release --repo "$LIVE_GITHUB_REPOSITORY"
```

Verify staging by listing secret names. This does not remove or change the existing repository token:

```sh
gh secret list --env marketplace-release --repo "$LIVE_GITHUB_REPOSITORY" --json name |
  jq -e 'any(.[]; .name == "VSCE_PAT")'
```

Complete cloud configuration and require a passing `verify_only` run on the PR branch before scheduling the cutover. Neither adding this environment token nor a green PR-branch run changes the old workflows on `main` or `develop`.

## Inject identifiers and verify on GitHub

```sh
printf %s "$LIVE_PROJECT_ID" | gh secret set VERTEX_LIVE_PROJECT_ID --repo "$LIVE_GITHUB_REPOSITORY"
printf %s "$LIVE_WIF_PROVIDER" | gh secret set VERTEX_LIVE_WIF_PROVIDER --repo "$LIVE_GITHUB_REPOSITORY"
printf %s "$LIVE_SERVICE_ACCOUNT" | gh secret set VERTEX_LIVE_SERVICE_ACCOUNT --repo "$LIVE_GITHUB_REPOSITORY"
```

The default models are Gemini 3.8 Flash and Claude Haiku 5.5 in `global`. To choose other supported catalog models, set `VERTEX_LIVE_GEMINI_MODEL`, `VERTEX_LIVE_CLAUDE_MODEL` and optional `VERTEX_LIVE_REGION` as repository variables. Switching projects/identities later means replacing the three secrets, not editing a public workflow or uploading ADC.

Allow IAM changes to propagate, then dispatch **Publish Pre-Release to VS Marketplace** explicitly on the PR branch with `verify_only=true`:

```sh
gh workflow run publish-prerelease.yml \
  --repo "$LIVE_GITHUB_REPOSITORY" \
  --ref codex/live-adc-release-gate \
  -f verify_only=true
```

This tests the actual prerelease VSIX using the dedicated CI ADC identity and skips Marketplace publication. The job must pass all six Gemini/Claude checks. Its uploaded JSON report redacts project/account/path values; no credential or raw host log is uploaded. A passing PR-branch run validates that identity and artifact; follow the cutover steps to enable enforcement on the release branches. Once enabled, normal publication runs repeat the gate before every release.

The repository changes do not create cloud resources or migrate credentials automatically. The updated workflows fail closed until authentication and model access are configured successfully. Existing workflows continue using the old flow while their repository Marketplace token remains available.

## Complete the token cutover

Run this step only at the [planned cutover](live-acceptance.md#rollout-status-and-cutover), after the dedicated GitHub ADC identity passes all six checks and the updated workflows reach both `develop` and `main`. Finish or cancel queued and running legacy publication jobs and pause new releases during the transition. Verify the environment secret exists before removing the repository-level copy. This lists only secret names and deletes the old repository secret only after that verification succeeds:

```sh
if gh secret list --env marketplace-release --repo "$LIVE_GITHUB_REPOSITORY" --json name |
  jq -e 'any(.[]; .name == "VSCE_PAT")' >/dev/null; then
  gh secret delete VSCE_PAT --repo "$LIVE_GITHUB_REPOSITORY"
else
  printf '%s\n' 'The environment VSCE_PAT is missing; the repository secret was not deleted.'
fi
```

The updated jobs receive the environment token; historical jobs without this environment cannot access it. Removing the repository copy retires the old publication flow. This is an explicit cutover step and is not performed by this PR or by adding the new secrets.

GitHub reads repository secrets when a workflow is queued and environment secrets when its job starts. Deleting the repository secret does not revoke the Marketplace token or remove a queued/running legacy job's earlier secret snapshot. Finish or cancel those jobs before completing the cutover. See [when GitHub reads secrets](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets) and [environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
