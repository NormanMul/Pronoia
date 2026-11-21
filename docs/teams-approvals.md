# Teams review notifications, not Teams approvals

Teams is an optional notification surface. GitHub Issues and their trusted
Actions audit remain authoritative. The integration sends no approval,
rejection, dispute, confirmation, email, or status mutation.

## Set up a Workflows webhook

1. In Teams, open the intended channel's **Workflows** app. Create a workflow
   with **When a Teams webhook request is received**, using an Adaptive Card
   posting template/action.
2. Configure it to post the incoming Adaptive Card to that channel. Do not add
   approval actions, HTTP decision callbacks, or GitHub status updates.
3. This sender uses a secret webhook URL, without an Entra Authorization header.
   Use the trigger's **Anyone** mode only if the administrator approves that
   arrangement. If tenant policy requires authenticated callers, leave this
   integration disabled; a 403 is not permission to weaken policy.
4. Add a co-owner, verify the Teams connection and channel access, and copy the
   workflow's current trigger URL into the Actions secret
   `TEAMS_WORKFLOW_WEBHOOK_URL`. Never place the URL in source, an issue,
   screenshots, or logs.
5. After deploying the CLI/workflow changes, test with an explicitly synthetic
   issue and an authorized human's GitHub command. Check the workflow run history
   and channel yourself. A webhook's HTTP acceptance does not prove delivery.

Office 365 connector-based Incoming Webhooks were retired in May 2026. Do not
use a legacy connector URL. The sender accepts HTTPS Power Automate
`*.api.powerplatform.com` or `*.logic.azure.com` workflow invocation URLs only.
Prefer the current URL copied from Workflows. Arbitrary paths, credential-bearing
URLs, fragments, redirects, non-HTTPS URLs, and non-443 ports are refused.
Sovereign-cloud hosts are not implemented.

## What the card means

Only the latest trusted, status-changing audit into **Validate**, **Blocked**,
or **Done**, still matching the canonical current state, is eligible:

- **Validate:** an uninvolved human must review the evidence on GitHub.
- **Blocked:** a human should review the blocker on GitHub.
- **Done:** informational notice of the existing governed workflow's outcome;
  the notification itself did not approve anything.

The Adaptive Card contains system-controlled text, the issue number, and exactly
one **Action.OpenUrl** to the configured board's canonical GitHub issue.
Untrusted issue titles, transcripts, URLs, and prose are not embedded in the
card. There are no submit/HTTP actions or status buttons.

An authorized human reviews on GitHub under the existing four-eyes and evidence
rules. Human approval, rejection, and dispute commands are interpreted only by
Actions. A Teams message, verbal decision, recap, external agent, or configured
`automation_logins` entry never supplies that authority. Human tokens used by
other agents still require the Pronoia agent marker; this hook refuses them.

## Receipts and retry semantics

The hook runs after successful command queue processing under its existing
per-issue concurrency. It verifies the returned `github-actions[bot]` identity
using the native `GITHUB_TOKEN`, not the workflow initiator's login.

After HTTP acceptance, it posts a bot-owned issue comment containing:

```text
<!-- pronoia:notification-receipt {"schema_version":1,"channel":"teams","audit_comment_id":123} -->
```

Only a receipt returned from `github-actions[bot]` suppresses that audit's next
card. A human/external agent's matching marker is ignored, even if that login
appears in `automation_logins`. Receipts do not contain webhook URLs or tokens.

Delivery is **at-least-once**, not exactly-once. A lost HTTP response, missing
receipt, failed receipt comment, or concurrent caller outside the governed issue
worker can cause duplicates. An accepted webhook with a failed receipt reports
degradation and the duplicate risk. Do not delete receipts to request a resend
without understanding that consequence.

Each webhook request has a ten-second deadline and at most two attempts for
network failures, HTTP 429, or 5xx responses. HTTP 403/404, invalid configuration,
and other errors produce explicit warnings without a success receipt.
Missing configuration reports `teams: "skipped"`; no integration error changes
the authoritative issue state.

## Official references

- [Teams Workflows setup, retirement, ownership, payload examples](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
- [Teams webhook trigger and authentication choices](https://learn.microsoft.com/en-us/connectors/teams#microsoft-teams-webhook)
- [Power Automate HTTP-trigger host allowlist](https://learn.microsoft.com/en-us/power-automate/ip-address-configuration)
- [GitHub GraphQL authentication and viewer query](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)
