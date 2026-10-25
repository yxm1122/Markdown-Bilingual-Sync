# Signal Relay: Webhook Forwarding CLI

Signal Relay forwards webhooks from one endpoint to many destinations, with retries, replay, and a local audit log. It runs as a single binary or as a Node.js package, so the same configuration works on a laptop and in production.

**Status:** stable · **Version:** 1.4.2 · **Runtime:** Node.js 20+ · [Release notes](https://example.com/signal-relay/releases)

## Features

- Fan-out delivery to up to 20 destinations per route, each with its own retry policy.
- Durable queue that survives restarts, plus a `replay` command for missed events.
- Signature verification for inbound requests and HMAC signing for outbound ones.
- Structured JSON logs with request ids, so a single event can be traced end to end.
- Local cache and preview UI for the last 100 deliveries, available without network access.
- Workspace-scoped routes, secrets, and audit trails for teams that share one host.

## Install

Signal Relay requires Node.js 20 or newer. Install the CLI from the public registry:

```bash
npm install --global signal-relay
signal-relay --version
```

Container images are published to `registry.example.com/signal-relay`; mount the configuration directory at `/etc/signal-relay` and pass secrets through the environment.

## Quick start

Create a route, start the listener, and send a test event:

```bash
signal-relay init --workspace ./demo
signal-relay route add orders \
  --from https://example.com/hooks/orders \
  --to https://example.com/services/billing
signal-relay serve --port 8787
```

In a second terminal, post a sample payload. The CLI prints a one-line summary and stores the event in the local cache:

```bash
curl -X POST http://localhost:8787/hooks/orders \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_1042","type":"order.created"}'
```

Run `signal-relay preview --workspace ./demo` to inspect the last ten deliveries before you enable retries.

## Configuration

Settings live in `relay.toml`. CLI flags override the file, and environment variables override both:

| Key | Type | Default | Description |
| :--- | :---: | --- | :--- |
| `workspace` | string | `./` | Directory for routes, logs, and the local cache |
| `retry.max_attempts` | integer | `6` | Attempts per destination before the event is parked |
| `retry.backoff` | string | `exponential` | Backoff strategy: `linear`, `exponential`, or `fixed` |
| `queue.size` | integer | `10000` | Events held in memory before spooling to disk |
| `signing.secret_env` | string | `RELAY_SIGNING_KEY` | Environment variable that holds the HMAC key |
| `log.level` | string | `info` | One of `debug`, `info`, `warn`, or `error` |

## Troubleshooting

- **Events stay queued.** Run `signal-relay status` and confirm that each destination answers a `HEAD` request within the 5 second timeout.
- **Signature verification fails.** Make sure the sender and the relay read the same `RELAY_SIGNING_KEY`, and rotate the key only after both sides are updated.
- **The cache grows without limit.** Lower `queue.size` or schedule `signal-relay cache prune --older-than 7d` during a maintenance window.

## Learn more

Read the [migration guide](https://example.com/signal-relay/migrate) before upgrading across major versions, and check the [deployment checklist](https://example.com/signal-relay/deploy) for production limits.[^limits]

[^limits]: The checklist lists supported operating systems and the maximum event size of 1 MiB.
