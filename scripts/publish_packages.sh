#!/usr/bin/env bash
# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0
#
# Publishes every workspace package whose version is not already in the target registry.
#
# Two properties matter more than brevity here. Re-running a release must be safe, so a
# version already present is skipped rather than retried into an error. And the version
# published is the one declared in the manifest, never one derived from the tag: the tag
# names the foundation release, and a package states its own line.

set -euo pipefail

registry="${1:?a target registry URL is required}"

npm pkg get name version --workspaces --json |
  node -e '
    const packages = JSON.parse(require("node:fs").readFileSync(0, "utf-8"));
    for (const entry of Object.values(packages)) {
      console.log(`${entry.name} ${entry.version}`);
    }
  ' |
  while read -r name version; do
    if npm view "${name}@${version}" version --registry "${registry}" >/dev/null 2>&1; then
      echo "already published, skipping: ${name}@${version}"
      continue
    fi
    echo "publishing ${name}@${version} to ${registry}"
    npm publish --workspace "${name}" --registry "${registry}"
  done
