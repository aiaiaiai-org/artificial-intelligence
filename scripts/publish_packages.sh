#!/usr/bin/env bash
# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0
#
# Publishes exact prepared npm tarballs to one registry.
#
# Re-running a release is safe only when an already-published version is the same artifact.
# A matching registry shasum is skipped; the same name/version with different bytes fails
# closed rather than silently treating someone else's package as this release.

set -euo pipefail

registry="${1:?a target registry URL is required}"
shift

if [ "$#" -eq 0 ]; then
  echo "no package tarballs supplied" >&2
  exit 2
fi

for archive in "$@"; do
  if [ ! -f "${archive}" ]; then
    echo "package tarball does not exist: ${archive}" >&2
    exit 2
  fi

  manifest="$(tar -xOf "${archive}" package/package.json)"
  read -r name version < <(
    printf '%s' "${manifest}" |
      node -e '
        const pkg = JSON.parse(require("node:fs").readFileSync(0, "utf-8"));
        if (typeof pkg.name !== "string" || typeof pkg.version !== "string") process.exit(2);
        process.stdout.write(`${pkg.name} ${pkg.version}\n`);
      '
  )
  local_shasum="$(sha1sum "${archive}" | awk '{print $1}')"

  error_log="$(mktemp)"
  set +e
  remote_json="$(npm view "${name}@${version}" dist.shasum --registry "${registry}" --json 2>"${error_log}")"
  status=$?
  set -e

  if [ "${status}" -eq 0 ]; then
    remote_shasum="$(
      printf '%s' "${remote_json}" |
        node -e '
          const value = JSON.parse(require("node:fs").readFileSync(0, "utf-8"));
          if (typeof value !== "string" || value.length === 0) process.exit(2);
          process.stdout.write(value);
        '
    )"
    rm -f "${error_log}"

    if [ "${remote_shasum}" != "${local_shasum}" ]; then
      echo "registry already contains ${name}@${version} with different bytes" >&2
      echo "local shasum:  ${local_shasum}" >&2
      echo "remote shasum: ${remote_shasum}" >&2
      exit 1
    fi

    echo "already published with identical bytes, skipping: ${name}@${version}"
    continue
  fi

  error_text="$(cat "${error_log}")"
  rm -f "${error_log}"
  if ! grep -Eq 'E404|404 Not Found' <<<"${error_text}"; then
    printf '%s\n' "${error_text}" >&2
    echo "could not determine whether ${name}@${version} already exists" >&2
    exit "${status}"
  fi

  echo "publishing ${name}@${version} to ${registry}"
  npm publish "${archive}" --registry "${registry}"
done
