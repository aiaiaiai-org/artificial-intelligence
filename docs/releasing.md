# Releasing, and what a consumer pins

This repository is a library. Until it is released, "consume it" means "pin a revision
reachable from `master`." This page defines how an immutable release becomes installable
without repeating correctness work that the pull request already proved.

## What a release is

A release starts from a `v*` tag on the current `master` merge commit. Publishing what a
moving branch happened to hold would hand consumers a version they cannot get back to, and
publishing an arbitrary historical commit would bypass the repository's sequential delivery
contract.

The tag names the Cargo workspace version: `v0.2.0` names a workspace at `0.2.0`. The npm
packages are versioned by their own manifests. `@aiaiaiai/contracts` currently tracks the
wire-contract line, while `@aiaiaiai/webllm` moves on its own package schedule.

## Cutting one

1. Land the release content through a pull request and let required correctness CI finish on
   its exact head.
2. Move `workspace.package.version` and every npm package version whose published contents
   changed. Move the wire-contract line whenever its compatibility surface changes.
3. Finish the `CHANGELOG.md` entry.
4. Tag the verified `master` merge commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The release workflow does **not** rerun the full Rust and Web correctness suites. Those are
PR responsibilities, and running the same suite again against the same tree would create a
second source of truth for one verification result.

Instead the release guard proves the chain of evidence:

- the tag version equals the Cargo workspace version;
- the tag names the current `master` commit;
- that commit is a two-parent pull-request merge;
- the merge tree equals its PR-head parent tree exactly; and
- the latest pull-request runs named `Rust CI`, `Web adapter CI`, and `Repository policy` for
  that exact head all completed successfully.

Only then does release-specific work begin. npm packages are packed once, retained as one
workflow artifact, and each publishing job consumes those exact tarballs. Registry jobs do
not rebuild them.

## Safe reruns

A package version is immutable. Re-running a release is therefore safe only when an existing
registry version is already the **same tarball**.

`scripts/publish_packages.sh` compares the prepared tarball's SHA-1 with the registry's
`dist.shasum`. An exact match is skipped. The same name and version with different bytes is a
hard failure; a lookup failure other than a genuine 404 also fails closed. This prevents a
rerun from silently accepting a conflicting artifact as if this release had published it.

## Registries

| Registry | When it runs | What a consumer needs |
|---|---|---|
| Public npm | when `NPM_TOKEN` is configured | nothing |
| GitHub Packages | when the npm scope equals the repository owner | an `.npmrc` naming the scope |

An unavailable registry is reported explicitly. Reaching neither registry is a failure: a
green workflow that publishes no installable package would be a false release.

**The current package scope is a constraint for GitHub Packages.** GitHub Packages maps an
npm scope to the repository owner. The packages are `@aiaiaiai/*`, while this repository is
owned by `aiaiaiai-org`, so that registry is not available under the current names.

Two coherent choices remain before an actual publish:

- keep `@aiaiaiai/*` and publish to public npm using an `NPM_TOKEN` from an account allowed
  to publish that scope; or
- rename the packages to `@aiaiaiai-org/*`, which also makes GitHub Packages eligible.

Changing package scope changes every consumer import, so it is a product naming decision,
not something the release workflow guesses.

## What a consumer writes

### A Rust product runtime

After the first tag exists:

```toml
[dependencies]
aiai-runtime = { git = "https://github.com/aiaiaiai-org/artificial-intelligence.git", tag = "v0.2.0" }
```

Before then, pin an exact revision reachable from `master`. Never pin a moving branch or a
feature-only commit that can become unreachable when its branch is deleted.

### A host client

After the corresponding npm package is published:

```sh
npm install @aiaiaiai/contracts
npm install @aiaiaiai/webllm   # only when the host runs local inference
```

If the package scope is later aligned for GitHub Packages, the consumer also configures that
scope in `.npmrc` and authenticates with a token permitted to read packages.

## Related

- [Consuming the foundation](consuming.md) — the port, failure, and pinning contract
- [The host side of the contract](host-contract.md)
- [CHANGELOG](../CHANGELOG.md)
