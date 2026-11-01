# Aperture CLI

Aperture CLI packages a web application into a signed release bundle. It runs on macOS, Linux, and Windows, and is designed for CI pipelines that need reproducible artifacts.

## Features

- Deterministic builds from a locked dependency graph.
- Signed manifest with SHA-256 digests for every asset.
- Parallel uploads with per-destination retry.
- Offline verification of an existing bundle.
- Machine-readable JSON output for automation.

## Install

```bash
npm install --global @aperture/cli
aperture --version
```

Aperture requires Node.js 20 or newer. The CLI reads `aperture.toml` from the current directory unless `--config` is provided.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `output` | `dist/bundle` | Directory for the generated bundle. |
| `parallelism` | `4` | Number of concurrent upload workers. |
| `signingKey` | unset | Path to the signing key used for the manifest. |
| `retries` | `3` | Number of attempts per destination. |

## Troubleshooting

If verification fails, run `aperture verify --verbose` to print the first mismatched digest. A missing `X-Aperture-Key` header usually means the upload destination rejected the request before the bundle was stored.

## Localization notes

- Audience: backend platform engineers and release managers.
- Tone: concise, formal, imperative; avoid marketing language.
- Terminology: "bundle" is 发布包; "manifest" is 清单; "aperture" stays Aperture.
- Do not translate: `aperture`, `aperture.toml`, `X-Aperture-Key`, `SHA-256`.
