#!/usr/bin/env python3
# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

"""Enforces the dependency boundaries the foundation's guarantees rest on.

Two of the workspace's claims are structural rather than procedural, and both are
dependency facts a reviewer would otherwise have to re-derive by reading imports:

1. The signal path cannot read runtime state. `aiai-signal` does not depend on
   `aiai-runtime`, so a training candidate has no session, proposal, admission, or
   effect type available to be derived from. Source separation holds because there
   is nothing there to separate from.
2. The contract and kernel crates carry no platform, async, or transport dependency,
   so neither can acquire ambient time, randomness, or I/O behind the explicit ports.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]

FORBIDDEN = {
    "crates/aiai-contracts/Cargo.toml": {
        "getrandom",
        "reqwest",
        "tokio",
        "uniffi",
        "wasm-bindgen",
    },
    "crates/aiai-runtime/Cargo.toml": {
        "getrandom",
        "rand",
        "reqwest",
        "tokio",
        "uniffi",
        "wasm-bindgen",
    },
    "crates/aiai-signal/Cargo.toml": {
        "aiai-runtime",
        "getrandom",
        "rand",
        "reqwest",
        "tokio",
    },
}

EXACT_DEPENDENCIES = {
    "crates/aiai-runtime/Cargo.toml": {"aiai-contracts", "serde"},
}

WEBLLM_PACKAGE = ROOT / "packages/aiai-webllm/package.json"

# Which runtime dependencies the browser adapter may carry. Versions are pinned by
# package-lock.json, not here: an architecture check should not need editing to bump a
# dependency it already allows.
WEBLLM_RUNTIME_DEPENDENCIES = {"@mlc-ai/web-llm"}

# Product vocabulary that must not appear in a product-agnostic foundation. Docs are
# exempt: they map product concepts onto these shapes and have to name both sides.
PRODUCT_TERMS = ("avaia", "bond", "nilx-one", "spectate")
PRODUCT_TERM_ROOTS = (
    ROOT / "crates",
    ROOT / "packages/aiai-webllm/src",
    ROOT / "packages/aiai-webllm/tests",
)
PRODUCT_TERM_SUFFIXES = (".rs", ".ts")


def dependency_names(path: pathlib.Path, include_dev: bool) -> set[str]:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    sections = ["dependencies", "build-dependencies"]
    if include_dev:
        sections.append("dev-dependencies")
    names: set[str] = set()
    for section in sections:
        names.update(data.get(section, {}).keys())
    return names


def main() -> int:
    failures: list[str] = []

    for relative, forbidden in FORBIDDEN.items():
        present = dependency_names(ROOT / relative, include_dev=True) & forbidden
        if present:
            failures.append(f"{relative}: forbidden dependencies: {', '.join(sorted(present))}")

    for relative, expected in EXACT_DEPENDENCIES.items():
        actual = dependency_names(ROOT / relative, include_dev=False)
        if actual != expected:
            failures.append(
                f"{relative}: dependencies must be exactly {sorted(expected)}, found {sorted(actual)}"
            )

    if not WEBLLM_PACKAGE.is_file():
        failures.append("missing browser-local inference package")
    else:
        package = json.loads(WEBLLM_PACKAGE.read_text(encoding="utf-8"))
        declared = set(package.get("dependencies", {}))
        if declared != WEBLLM_RUNTIME_DEPENDENCIES:
            failures.append(
                "packages/aiai-webllm runtime dependencies must be exactly "
                f"{sorted(WEBLLM_RUNTIME_DEPENDENCIES)}, found {sorted(declared)}"
            )

    for root in PRODUCT_TERM_ROOTS:
        if not root.is_dir():
            failures.append(f"{root.relative_to(ROOT)}: missing source root")
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix not in PRODUCT_TERM_SUFFIXES or not path.is_file():
                continue
            source = path.read_text(encoding="utf-8").casefold()
            present = [term for term in PRODUCT_TERMS if term in source]
            if present:
                failures.append(
                    f"{path.relative_to(ROOT)}: product vocabulary in the foundation: "
                    f"{', '.join(present)}"
                )

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1

    print("architecture dependency boundary: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
