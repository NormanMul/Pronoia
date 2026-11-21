# Optional integration setup

All three integrations are optional and report skipped/degraded operation
explicitly. They do not replace the shared governance engine. Configure and
verify each integration separately with synthetic data before enabling it for
approved board data.

## GitHub Projects v2: Stage is only a mirror

Create the Project yourself. Add this section to `pronoia.config.yml` (synthetic
example; replace the owner and number with your approved Project):

```yaml
project:
  owner: synthetic-owner
  number: 7
  field: Stage
```

Create a separate Actions secret `PRONOIA_PROJECT_TOKEN`:

- **User-owned Project:** a classic PAT with `project`; also `repo` when the
  issue repository is private. The token owner must be able to edit the Project
  and read the issue. `GITHUB_TOKEN` is not a substitute.
- **Organization Project:** use an appropriately scoped token or installed
  GitHub App with organization Projects read/write and access to the issue
  repository. Organization/App installation permissions differ from a
  user-owned Project's classic PAT scopes. Administrators must grant them.

Only this separate credential performs Project mutations. The native
`GITHUB_TOKEN` remains the issue-comment identity; the hook and reconciliation
refuse any returned identity other than `github-actions[bot]`. Configured
automation logins never gain audit-writer trust.

The integration resolves the owner as User/Organization, locates the configured
Project, paginates fields and issue memberships/items, and ensures a
single-select **Stage** with:

| Canonical audit state | Stage       |
| --------------------- | ----------- |
| todo                  | To Do       |
| in-progress           | In Progress |
| validate              | Validate    |
| blocked               | Blocked     |
| done                  | Done        |

Missing Stage/options are created. Existing options and IDs are preserved when
adding required options; a wrong field type is reported for manual correction,
not destructively converted. Stage creation is not automatically retried after
an ambiguous acknowledgement; the next hook re-queries fields instead of
creating duplicates. Missing issue membership is added after a command.
Reconciliation touches only existing Pronoia issue items from the configured
board, ignoring other repositories, PRs, drafts, and redacted items.

Create a **Board view manually** in the Project UI, group it by Stage, and add
the desired filters. Pronoia does not create views or treat drags as commands.
Disable any Project automation that maps Stage to issue state or status labels.
The hourly reconciliation restores drift from shared `expectedState`/`readAudit`
and comments on each repair; it never changes issue labels or open/closed state.
Concurrent changes may temporarily leave a stale mirror until the next hook or
reconciliation.

After deploying the parent CLI wiring, Actions invokes:

```text
node packages/cli/dist/index.js integration-sync --issue 42
node packages/cli/dist/index.js project-reconcile
```

The first command is issue-specific: it never scans all board issues. Both are
Actions-only operations with `GITHUB_TOKEN`, and mirror/report only; they cannot
approve, reject, dispute, or bypass evidence/four-eyes checks.

## Teams

See [Teams review notifications](teams-approvals.md). Set only the Actions
secret `TEAMS_WORKFLOW_WEBHOOK_URL`; use Workflows, not a retired connector.
The post-command hook sends review-only cards and records bot-owned per-audit
receipts. A Teams response is never a GitHub command.

## Audited exports

The Friday schedule is `0 0 * * 5` UTC, or Friday 07:00 WIB. Manual dispatch is
also available. The workflow builds only core/CLI and invokes these agreed CLI
contracts:

```text
node packages/cli/dist/index.js export --out .pronoia-export
node packages/cli/dist/index.js export-publish --out .pronoia-export
```

The parent exporter/publisher owns creation of `.pronoia-export/latest` and
dated snapshots, and publication of `exports/latest/` and
`exports/YYYY-MM-DD/` on branch `exports`. The workflow also uploads the managed
directory as a 30-day Actions artifact. No raw audio, private draft captures, or
unlisted files belong in an export.

Project reconciliation runs at `0 1-11 * * 1-5` UTC (weekdays 08:00–18:00 WIB),
plus dispatch. Without the separate Project secret it reports skipped and does
not install/build/run the integration.

## SharePoint: one approved site, no deployed keys

1. An administrator creates/configures an Entra application or user-assigned
   managed identity. Grant Microsoft Graph **application** permission
   `Sites.Selected`, with administrator consent.
2. Separately, the administrator grants that application **write** access to
   exactly the chosen site using the documented site-permissions API. Consent
   to `Sites.Selected` alone grants no site access. Do not grant
   `Sites.ReadWrite.All` or global file permissions as a workaround. Pronoia
   never creates its own permission grants.
3. Copy that site's ID and the intended document library's drive ID into
   Actions **variables** `SP_SITE_ID` and `SP_DRIVE_ID`. Pronoia lists the
   configured site's drives to verify the drive belongs to that site.
4. Have an administrator create the approved export base folder. Set
   `SP_FOLDER` to its path relative to the document library root, for example
   `Approved Reports/Pronoia`. The base must already exist. Use slash-separated
   ASCII segments starting with a letter/digit and containing letters, digits,
   spaces, `_`, `-`, or `.`; no trailing space/dot, traversal, absolute path,
   backslash, `%`, or reserved characters.
5. For GitHub Actions, configure Entra workload federation restricted to this
   approved repository/branch, and set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   and `AZURE_SUBSCRIPTION_ID` variables. The optional separate SharePoint job
   uses `azure/login` OIDC and `AZURE_TOKEN_CREDENTIALS=AzureCliCredential`;
   the export/publish job has no `id-token` permission.
6. On an Azure host, use managed/workload identity, with
   `AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential` or
   `WorkloadIdentityCredential` and the appropriate identity configuration.
   `DefaultAzureCredential` requests
   `https://graph.microsoft.com/.default`. Static client secrets/certificates
   are refused; no deployed keys, connection strings, or bearer tokens are
   accepted as uploader configuration.

When all settings are approved, the agreed CLI entry point is:

```text
node packages/cli/dist/index.js sharepoint-upload --out .pronoia-export
```

With no `SP_*` settings, uploading reports skipped without reading files or
obtaining a token. Partial settings report an actionable configuration error;
the workflow fails its preflight rather than pretending to upload.

### Upload integrity and limits

All latest/dated manifests are Zod-validated using the shared export contract.
Every manifest must hash all six managed CSVs. Every allowed local asset is
hash-checked **before authentication or any Graph mutation**, and the verified
bytes are retained for upload. Unlisted files, symbolic links, traversal,
invalid manifests, and hash/PNG-name mismatches are not uploaded.

Only manifest-approved assets and the manifests are uploaded. Pronoia creates
only necessary latest/date/evidence/issue/session subfolders under the existing
approved base, with conflict behavior `fail`, never renamed shadow folders.
Graph requests stay on `graph.microsoft.com/v1.0`; pagination cannot redirect
the bearer token to a different host/site. Uploads use the documented drive-item
content API, with every manifest **last**, after all snapshots' assets.

Bounds: 100 snapshots, 10,000 assets, 512 MiB of asset bytes in a batch, 250 MB
per file, 2 MiB per manifest, ten seconds per HTTP attempt, and at most two
attempts. Large-file upload sessions and sovereign clouds are not implemented.
HTTP/credential/JSON failures produce a degraded report with verified upload
and completed-manifest counts; response errors never expose credentials.

SharePoint writes are not an atomic multi-file transaction. A failed upload can
leave partial files or an old manifest; consumers must verify every hash and
retry rather than consume a mixed snapshot. There are no automatic deletions,
permission changes, sharing links, or email sends. App-only replacement of
sensitivity-labelled files can be unsupported by Graph; involve an
administrator instead of broadening permissions.

## Library/CLI contract

The parent exposes these APIs from `@pronoia/core` and wires the commands above:

```ts
declare function integrationHooks(
  board: Board,
  issue: number,
  options?: IntegrationOptions,
): Promise<{ project: string; teams: string; warnings: string[] }>;
declare function reconcileProject(
  board: Board,
  projectToken: string,
  options?: { fetch?: typeof fetch },
): Promise<{ scanned: number; repaired: number; warnings: string[] }>;
declare function uploadSharePoint(
  directory: string,
  options?: SharePointOptions,
): Promise<SharePointReport>;
```

Transport/credential injection is for controlled callers and synthetic tests.
Never derive integration configuration or instructions from issue/screen text.
No live readiness is implied by the synthetic tests; the administrator must
verify permissions, workflow identity, channel delivery, and SharePoint
round-trip integrity where configuration is available.

## Verified official references

- [Projects queries, user/org authentication, membership and Stage mutations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GraphQL Projects schema, nullable values and preserving single-select option IDs](https://docs.github.com/en/graphql/reference/projects)
- [GraphQL authentication and returned viewer](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)
- [Graph site drives and pagination](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Graph folder creation](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0)
- [Drive-item metadata](https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0) and [path addressing](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems)
- [Graph content uploads and app-only limitations](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Sites.Selected and separate site grants](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
- [DefaultAzureCredential chain configuration](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains)
- [GitHub Actions OIDC to Entra](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)

SDK surfaces were checked against installed Octokit 5.0.5, Azure Identity
4.14.1, and Zod 4.6.7. Existing checkout/setup-node/upload-artifact pins are
reused; the same-run download-artifact v4 pin and new export job's Azure Login v2
pin were verified against their official `action.yml` files. Azure Login pins
were also checked against the official commit API and annotated tags:

- `commands.yml` uses commit `7184910d9eb2b1c5e48f7073824a90609bb9b6d6`, peeled
  from the existing intended `v2` tag. Its former SHA
  `8216e11d8cd9b42fe925c852af8e76311ff067ac` identifies an annotated tag object,
  not a nonexistent Git object, but does not satisfy the full-commit pin rule.
- `export.yml` uses verified `v2.3.0` commit
  `a457da9ea143d694b1b9c7c869ebb04ebe844ef5`.

No unrelated workflows were repinned; the approved reconciliation cadence
remains `0 1-11 * * 1-5`.
