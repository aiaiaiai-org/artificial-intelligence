# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SPDX = sys.argv[1] if len(sys.argv) > 1 else ""
REQUIRED_FILES = ("LICENSE", "NOTICE", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "CLA.md", "TRADEMARKS.md", "SECURITY.md")
AUTHORED_EXTENSIONS = {".bash", ".c", ".cc", ".cjs", ".cpp", ".css", ".cxx", ".h", ".hpp", ".htm", ".html", ".hxx", ".java", ".js", ".jsx", ".kt", ".kts", ".less", ".m", ".mjs", ".mm", ".py", ".rake", ".rb", ".rs", ".sass", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".yaml", ".yml", ".zsh"}
AUTHORED_FILENAMES = {"Dockerfile", "Makefile"}
EXCLUDED_DIRS = {".git", ".venv", "build", "coverage", "dist", "fixtures", "generated", "node_modules", "snapshots", "target", "third_party", "vendor", "venv"}
EXCLUDED_FILENAMES = {"Cargo.lock", "Gemfile.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"}
COPYRIGHT = re.compile(r"© 20\d{2}(?:–20\d{2})? aiaiaiai · aiaiaiai\.org")


# A published npm tarball is a distribution of its own, and Apache-2.0 attribution has to
# travel inside it rather than only in the repository it was built from. `files` decides
# what npm packs, so an edit there is all it takes to ship a package with no license.
PUBLISHABLE_PACKAGE_FILES = ("LICENSE", "NOTICE", "README.md")


def publishable_packages() -> list[Path]:
    return sorted(path.parent for path in ROOT.glob("packages/*/package.json"))


def check_publishable_packages(errors: list[str]) -> None:
    for package in publishable_packages():
        relative = package.relative_to(ROOT)
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
        if manifest.get("private") is True:
            continue
        for name in PUBLISHABLE_PACKAGE_FILES:
            if not (package / name).is_file():
                errors.append(f"{relative}: publishable package is missing {name}")
        packed = manifest.get("files")
        if packed is None:
            continue
        for name in ("LICENSE", "NOTICE"):
            if name not in packed:
                errors.append(f"{relative}: package.json 'files' does not pack {name}")
        if manifest.get("license") != EXPECTED_SPDX:
            errors.append(f"{relative}: package.json license must be {EXPECTED_SPDX}")


def authored_file(path: Path) -> bool:
    if path.name in EXCLUDED_FILENAMES or any(part in EXCLUDED_DIRS for part in path.relative_to(ROOT).parts):
        return False
    return path.name in AUTHORED_FILENAMES or path.suffix.lower() in AUTHORED_EXTENSIONS


def validate() -> list[str]:
    errors: list[str] = []
    if EXPECTED_SPDX not in {"MPL-2.0", "Apache-2.0"}:
        return ["Expected SPDX id must be MPL-2.0 or Apache-2.0"]
    for relative in REQUIRED_FILES:
        if not (ROOT / relative).is_file():
            errors.append(f"missing required file: {relative}")
    if (ROOT / "LICENSE").is_file():
        text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        marker = "Mozilla Public License Version 2.0" if EXPECTED_SPDX == "MPL-2.0" else "Apache License"
        if marker not in text:
            errors.append(f"LICENSE does not match {EXPECTED_SPDX}")
    if (ROOT / "NOTICE").is_file() and "© 2026 aiaiaiai · aiaiaiai.org" not in (ROOT / "NOTICE").read_text(encoding="utf-8"):
        errors.append("NOTICE does not contain the canonical aiaiaiai signature")
    if (ROOT / "README.md").is_file() and EXPECTED_SPDX not in (ROOT / "README.md").read_text(encoding="utf-8"):
        errors.append(f"README.md does not declare {EXPECTED_SPDX}")
    check_publishable_packages(errors)
    expected_line = f"SPDX-License-Identifier: {EXPECTED_SPDX}"
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or not authored_file(path):
            continue
        relative = path.relative_to(ROOT)
        try:
            head = "\n".join(path.read_text(encoding="utf-8").splitlines()[:12])
        except UnicodeDecodeError:
            errors.append(f"authored source is not UTF-8: {relative}")
            continue
        if not COPYRIGHT.search(head):
            errors.append(f"missing canonical copyright header: {relative}")
        if expected_line not in head:
            errors.append(f"missing {expected_line}: {relative}")
    return errors


if __name__ == "__main__":
    problems = validate()
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        raise SystemExit(1)
    print(f"repository policy OK ({EXPECTED_SPDX})")
