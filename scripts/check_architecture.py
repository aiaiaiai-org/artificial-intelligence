#!/usr/bin/env python3
# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

"""Enforces the dependency boundaries the foundation's guarantees rest on.

Three of the workspace's claims are structural rather than procedural, and each is a
fact about the tree that a reviewer would otherwise have to re-derive by reading it:

1. The signal path cannot read runtime state. `aiai-signal` does not depend on
   `aiai-runtime`, so a training candidate has no session, proposal, admission, or
   effect type available to be derived from. Source separation holds because there
   is nothing there to separate from.
2. The contract and kernel crates carry no platform, async, or transport dependency,
   so neither can acquire ambient time, randomness, or I/O behind the explicit ports.
3. The wire contract has two implementations, and both answer against one shared corpus.
   "A drifting mirror fails a build" holds only while every side still reads that corpus,
   so the corpus and its readers are checked to exist rather than assumed to.
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

# Which runtime dependencies each host-side package may carry. Versions are pinned by
# package-lock.json, not here: an architecture check should not need editing to bump a
# dependency it already allows.
#
# The empty set for aiai-contracts is the package's whole claim. It is the wire contract a
# host adopts in order to talk to this foundation, and a contract that dragged a dependency
# tree in with it would be a framework instead.
PACKAGE_RUNTIME_DEPENDENCIES = {
    "packages/aiai-contracts/package.json": set(),
    "packages/aiai-webllm/package.json": {"@mlc-ai/web-llm"},
}

# The corpus both implementations of the wire contract answer against, and the files that
# read it. Losing any one of them would leave a mirror free to drift in silence.
WIRE_FIXTURE = "fixtures/contract-wire-0.2.0.json"
WIRE_FIXTURE_READERS = (
    "crates/aiai-contracts/tests/wire_conformance.rs",
    "crates/aiai-runtime/tests/activation_conformance.rs",
    "packages/aiai-contracts/tests/fixture.ts",
)

# Product vocabulary that must not appear in a product-agnostic foundation. Docs are
# exempt: they map product concepts onto these shapes and have to name both sides.
PRODUCT_TERMS = ("avaia", "bond", "nilx-one", "spectate")
PRODUCT_TERM_ROOTS = (
    ROOT / "crates",
    ROOT / "packages/aiai-contracts/src",
    ROOT / "packages/aiai-contracts/tests",
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

    for relative, expected in PACKAGE_RUNTIME_DEPENDENCIES.items():
        manifest = ROOT / relative
        if not manifest.is_file():
            failures.append(f"missing host-side package manifest: {relative}")
            continue
        declared = set(json.loads(manifest.read_text(encoding="utf-8")).get("dependencies", {}))
        if declared != expected:
            failures.append(
                f"{relative}: runtime dependencies must be exactly "
                f"{sorted(expected)}, found {sorted(declared)}"
            )

    if not (ROOT / WIRE_FIXTURE).is_file():
        failures.append(f"missing shared wire corpus: {WIRE_FIXTURE}")
    fixture_name = pathlib.PurePath(WIRE_FIXTURE).name
    for relative in WIRE_FIXTURE_READERS:
        reader = ROOT / relative
        if not reader.is_file():
            failures.append(f"missing wire corpus reader: {relative}")
        elif fixture_name not in reader.read_text(encoding="utf-8"):
            failures.append(f"{relative}: no longer reads {WIRE_FIXTURE}")

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
