# Contributing to artificial-intelligence

Contributions are welcome. This repository is the product-agnostic AI foundation for the aiaiaiai ecosystem and must remain independent of product-specific semantics.

## Before Changing Code

Keep reusable AI execution concerns here: model/inference interfaces, provider adapters, routing, runtime primitives, memory/planning/tool abstractions, evaluation, and observability. Product-specific concepts such as 0x1 Bond/BondChain or Prism publishing workflows belong in product repositories.

Keep contributions narrowly scoped. Explain the problem, preserve provider-agnostic boundaries, and include verification appropriate to the affected surface.

## Pull Requests

Prefer one coherent task per pull request. State what changes, why it is needed, which reusable contract owns the behavior, what was verified, and whether compatibility, licensing, security, model/provider behavior, or migration changes.

## Source Licensing

New authored source and configuration files that support comments must begin with the canonical repository header for their file format. For Rust and other `//`-comment formats:

```text
// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0
```

Use equivalent comment syntax for other formats. Do not inject headers into JSON, lockfiles, generated output, vendored third-party files, snapshots, or formats where comments would break the contract.

Run `python scripts/check_repository_policy.py Apache-2.0` before submitting. Required GitHub CI runs the same check.

## Contribution Rights

Contributors keep ownership of their original contributions.

By intentionally submitting work for inclusion in this repository, the contributor is expected to provide the rights described in [CLA.md](CLA.md). The intended grant lets the project integrate, modify, distribute, sublicense, and relicense accepted work while leaving the contributor free to use their original contribution elsewhere.

The CLA is currently provisional until a production acceptance mechanism is finalized. Maintainers may require explicit signed or electronic acceptance before merging an external contribution.

## Third-Party Material

Do not introduce code, model artifacts, datasets, generated material, assets, or dependencies whose terms conflict with Apache-2.0 or with the project's ability to distribute accepted work. Identify externally sourced model/data terms explicitly and preserve required notices.

## Identity

The source license does not grant rights to imply that a fork or derivative is maintained, sponsored, or endorsed by aiaiaiai. See [TRADEMARKS.md](TRADEMARKS.md).

---

© 2026 aiaiaiai · aiaiaiai.org
