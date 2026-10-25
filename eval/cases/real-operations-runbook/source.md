# Payments API Deployment Runbook

This runbook covers a production deployment of the Payments API, the smoke checks that follow it, and the rollback path if error rates rise. Use it during the weekly release window or any emergency change approved by the incident commander.

> [!WARNING]
> Deployments are frozen during the month-end close. If you are reading this outside the approved window, stop and confirm with the payments on-call before running any command.

## Prerequisites

- Access to the `payments-prod` cluster and the `deployer` role in the release namespace.
- A status note in the incident channel, with the current version and the target version.
- The [deployment dashboard](https://example.com/ops/payments) open in a second tab.
- Credentials loaded through `payments-auth login --env prod`; never paste keys into a shell history.
- A change ticket approved for the target date, linked from the incident channel topic.

## Deployment

1. Confirm that the release branch is green in CI and that no migration is marked as mandatory.
2. Tag the release as `payments-api-2026.10.3` and push the tag with `git push origin payments-api-2026.10.3`.
3. Announce the start time and the tag in `#payments-releases`, then wait for two acknowledgements.
4. Apply the deployment with `kubectl apply -k overlays/prod` and watch the rollout until all replicas report ready.
5. Verify the version endpoint with `curl -s https://api.example.com/payments/version`.

The smoke check must pass before you announce completion. Send a request to the staging endpoint with a fixed idempotency key:

```json
{
  "account_id": "acct_9f2",
  "amount_cents": 4800,
  "currency": "USD",
  "idempotency_key": "deploy-check-001"
}
```

A healthy service returns the created invoice and the request id within 300 ms:

```json
{
  "invoice_id": "inv_20481",
  "status": "open",
  "request_id": "req_7c1a"
}
```

Record the request id in the incident channel and compare it with the traces in the dashboard before you close the smoke check.

## Error codes

| Code | Meaning | Action |
| :---: | :--- | :--- |
| `400` | Malformed JSON or a missing field | Fix the payload and retry; do not page on-call. |
| `401` | Missing or expired access token | Reissue the token, update the secret, and rerun the smoke check. |
| `409` | Duplicate idempotency key with a different body | Reuse the original body, or wait 24 hours before retrying. |
| `429` | Rate limit exceeded | Back off for 60 seconds, then retry up to three times. |
| `502` | Upstream ledger returned an invalid response | Wait two minutes, retry once, and escalate if the code repeats. |
| `503` | Upstream ledger unavailable | Open an incident, follow the rollback steps, and notify the payments channel. |

## Rollback

Stop the rollout as soon as the 5xx rate stays above 2 percent for five minutes, or when the smoke check fails twice. Then:

1. Scale the new version to zero with `kubectl scale deploy/payments-api --replicas=0`.
2. Restore the previous tag with `kubectl apply -k overlays/prod@payments-api-2026.10.2`.
3. Replay the smoke check and compare the response with the previous `request_id`.
4. Record the rollback reason, the failing code, and the time in the incident channel.

> **Note:** Rollback does not undo database migrations. If migration `2026_10_add_invoice_index` has already run, follow the migration guide linked in the incident template before restoring traffic.

## Getting help

Read the [API status page](https://status.example.com/payments) first, then page the payments on-call through the [on-call schedule](https://example.com/ops/on-call). Escalate to the platform team if the ledger is unreachable for more than 15 minutes.
