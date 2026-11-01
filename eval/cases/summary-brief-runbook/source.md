# Relay Queue Failover Runbook

This runbook covers the controlled failover of the Relay Queue service from the primary region to the standby region. It is written for the on-call rotation and assumes the operator has access to the incident channel and the deployment console.

## Preconditions

- The primary region is degraded or unavailable.
- The incident commander has approved the failover.
- The standby region has enough capacity for the current queue depth.
- Recent backups have been verified.

## Procedure

1. Open the deployment console and select **Relay Queue**.
2. Confirm that the standby region reports a healthy cluster.
3. Set `RELAY_CLUSTER` to the standby cluster name.
4. Run `relayctl failover --to standby --confirm`.
5. Watch the replication lag until it reaches zero.
6. Send a status update in the incident channel.
7. Verify that new messages are accepted in the standby region.

## Rollback

If the standby region does not become healthy within ten minutes, run `relayctl failover --to primary --confirm`. Do not delete the standby cluster until the primary has served traffic for at least thirty minutes.

## Error codes

| Code | Meaning | Action |
| --- | --- | --- |
| `HTTP 503` | No healthy coordinator | Wait and retry the failover command. |
| `REL-1042` | Replication lag exceeds the limit | Check network latency between regions. |
| `REL-2087` | Standby capacity is insufficient | Scale the standby cluster before retrying. |

## Localization notes

- Audience: SREs and on-call engineers.
- Tone: direct, calm, step-oriented; use short sentences.
- Terminology: "failover" is 故障切换; "shard" is 分片; "replication lag" is 复制延迟.
- Do not translate: `relayctl`, `RELAY_CLUSTER`, `us-east-1`, `HTTP 503`, `REL-1042`.
