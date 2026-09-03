# artificial-intelligence

Product-agnostic artificial intelligence foundation for the aiaiaiai ecosystem.

This repository owns reusable AI execution primitives and contracts: model/inference interfaces, provider adapters, routing, runtime primitives, memory/planning/tool abstractions, evaluation, and common observability. Product-specific semantics belong in product-specific repositories.

## Workspace

```text
crates/
├── aiai-contracts   # binding-safe versioned values, closed envelopes, typed failures
├── aiai-runtime     # replaceable-computation kernel: continuity, activation, authority
└── aiai-signal      # closed-schema behavioral signal transform and validator
```

Dependency direction is one-way: `aiai-runtime` and `aiai-signal` depend only on
`aiai-contracts`, and `aiai-signal` never depends on `aiai-runtime`.

The workspace deliberately contains no participant, relationship, interaction, or record
type. Product payloads pass through as opaque generic parameters, so the foundation cannot
branch on what a product means by them. What it does own is the set of refusals every
product's AI runtime needs: a model proposal cannot become an action without an authority
decision, replacing a runtime cannot mint a different subject, a dormant runtime produces
nothing, an unavailable port is a typed failure rather than a substituted value, and a
behavioral signal carries no field its schema did not declare.

See [Architecture](docs/architecture.md), and
[Integrating a product AI runtime](docs/nilx-one-ai-integration.md) for how a product
repository composes these crates.

## Local verification

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
python3 scripts/check_architecture.py
python scripts/check_repository_policy.py Apache-2.0
```

Dependency license, source, and advisory policy is enforced with `cargo deny check` in CI.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [CLA.md](CLA.md), and [TRADEMARKS.md](TRADEMARKS.md) before submitting substantial work.

New authored source and configuration files must carry the canonical aiaiaiai copyright signature and `SPDX-License-Identifier: Apache-2.0` when the format supports comments. Repository policy CI validates this automatically.

## License

Licensed under the Apache License, Version 2.0 (`Apache-2.0`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

© 2026 aiaiaiai · aiaiaiai.org
