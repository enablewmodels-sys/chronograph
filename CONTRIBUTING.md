# Contributing

Chronograph is an early embedded temporal graph database. Useful contributions include reproducible bug reports, examples from actual workflows, documentation corrections and measured improvements to temporal queries or ingestion.

Read the [quickstart](docs/QUICKSTART.md), [architecture](docs/ARCHITECTURE.md), [file format](docs/FORMAT.md) and [current limits](docs/LIMITATIONS.md). The [replay tutorial](docs/TUTORIAL.md) is a small starting point.

## Discuss a change

Use the repository issue templates for a bug, feature proposal or alpha trial report once the repository is public. For a large change, describe the concrete workload and tradeoffs before starting. Include what you tried and how you would verify improvement. Do not attach private graph files, credentials or personal research data; prefer a minimal synthetic reproduction.

For security findings, follow [SECURITY.md](SECURITY.md); never publish exploit details in an issue. The current authentication design is described in [security documentation](docs/SECURITY.md).

## Develop locally

Requirements are Rust 1.93+, Node.js 20.19+ or 22.12+, and npm. Follow the quickstart to run the server and frontend. The embedded library can be built without the frontend.

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

For UI and service work, use the relevant protocol and browser checks in [testing](docs/TESTING.md). `scripts/verify.sh` runs the complete local verification workflow, installs audit/browser tooling and generates benchmark evidence. Document checks you could not run. A documentation-only change usually needs its links and runnable examples checked, rather than the full performance suite.

## Send a pull request

Explain the problem, resulting behavior and validation. Keep the scope reviewable. If the change affects interval semantics, demonstrate late events, equal timestamps and invalidation behavior. If it changes persistence, preserve checked format fixtures, test recovery at every new record boundary, and explicitly design any required migration.

Performance changes need a reproducible workload with dataset size, ordering, durability mode, hardware, returned row count and timing boundaries. Keep construction time separate from consumed query work. Do not replace a missed target with a measurement from a smaller workload.

By submitting code or documentation, you offer your contribution under the project's PolyForm Perimeter 1.0.0 license. See [LICENSE](LICENSE) and preserve [NOTICE](NOTICE). Submit work you are entitled to contribute and preserve third-party notices. No ownership transfer or separate CLA is introduced here.

Be respectful, explain disagreements concretely and make it easy for others to reproduce your result. The public release is an alpha; API stability, response-time commitments and support agreements have not been established.
