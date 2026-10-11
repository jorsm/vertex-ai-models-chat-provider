# Google Cloud identity for GitHub live tests

Use a dedicated service account with Workload Identity Federation (WIF). GitHub creates temporary ADC for the release job; local user ADC and service-account keys are not uploaded. If you already have a suitable identity/provider, set the three repository secrets in [live acceptance](live-acceptance.md#github-setup) and skip creation.

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

Both release jobs use the `marketplace-release` environment. This changes the OIDC subject (`sub`) to include the environment; the provider above authorizes immutable repository/owner IDs, `ref`, event and `workflow_ref`, and its IAM binding uses the repository ID. Neither rule requires a literal `sub` value, so this environment change needs no WIF configuration change. Adapt an existing provider if it instead authorizes a specific `sub` value.

## Move the Marketplace token into the release environment

Create `marketplace-release` under **Settings → Environments** in the repository. Allow the intended release tags and prerelease branches in its deployment rules. Store the Marketplace token only in that environment: historical tag-push workflows may otherwise retain access to a repository-level `VSCE_PAT` and publish without the new gate. The three live-test identity identifiers stay as repository secrets.

Run this command in an interactive terminal and paste the token at the prompt. Do not put the token in command arguments, a shell variable or a local file:

```sh
gh secret set VSCE_PAT --env marketplace-release --repo "$LIVE_GITHUB_REPOSITORY"
```

Verify the environment secret exists before removing the repository-level copy. This lists only secret names and deletes the old repository secret only after that verification succeeds:

```sh
if gh secret list --env marketplace-release --repo "$LIVE_GITHUB_REPOSITORY" --json name |
  jq -e 'any(.[]; .name == "VSCE_PAT")' >/dev/null; then
  gh secret delete VSCE_PAT --repo "$LIVE_GITHUB_REPOSITORY"
else
  printf '%s\n' 'The environment VSCE_PAT is missing; the repository secret was not deleted.'
fi
```

The updated jobs receive the environment token; historical jobs without this environment cannot access it. This migration is a required GitHub setup step and is not performed by repository changes. See [GitHub's environment documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Inject identifiers and verify on GitHub

```sh
printf %s "$LIVE_PROJECT_ID" | gh secret set VERTEX_LIVE_PROJECT_ID --repo "$LIVE_GITHUB_REPOSITORY"
printf %s "$LIVE_WIF_PROVIDER" | gh secret set VERTEX_LIVE_WIF_PROVIDER --repo "$LIVE_GITHUB_REPOSITORY"
printf %s "$LIVE_SERVICE_ACCOUNT" | gh secret set VERTEX_LIVE_SERVICE_ACCOUNT --repo "$LIVE_GITHUB_REPOSITORY"
```

The default models are Gemini 3.8 Flash and Claude Haiku 5.5 in `global`. To choose other supported catalog models, set `VERTEX_LIVE_GEMINI_MODEL`, `VERTEX_LIVE_CLAUDE_MODEL` and optional `VERTEX_LIVE_REGION` as repository variables. Switching projects/identities later means replacing the three secrets, not editing a public workflow or uploading ADC.

After committing and pushing the gate files, allow IAM changes to propagate, then dispatch **Publish Pre-Release to VS Marketplace** on that ref with `verify_only=true`. This tests the actual prerelease VSIX using the dedicated CI ADC identity and skips Marketplace publication. The job must pass all six Gemini/Claude checks. Its uploaded JSON report redacts project/account/path values; no credential or raw host log is uploaded. Once that GitHub run passes, normal publication runs still repeat the gate before each release.

The repository changes do not create these cloud resources or secrets automatically. Until authentication and model access are configured successfully, publication fails closed.
