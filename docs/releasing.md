# Releasing, and what a consumer pins

This repository is a library. Until it is released, "consume it" means "pin a revision and
hope the branch it came from is never deleted." This page is how that stops being true.

## What a release is

A release is a tag. `.github/workflows/release.yml` runs on `v*` and on nothing else,
because publishing what a moving branch happened to hold would hand consumers a version
they cannot get back to.

The tag names the Cargo workspace version, and the workflow refuses a tag that does not:
`v0.2.0` is a release of the workspace at `0.2.0`. The npm packages are **not** versioned
by the tag — each states its own version in its manifest, and the workflow publishes that.
`@aiaiaiai/contracts` happens to track the contract line, so it reads `0.2.0` too;
`@aiaiaiai/webllm` is at `0.1.0` and moves on its own schedule.

## Cutting one

1. Land the change. `master` is what a consumer pins, so a revision that only ever existed
   on a feature branch is orphaned when that branch is deleted — which is why foundation
   pull requests that consumers already pin are merged, not squashed.
2. Move the version. Bump `workspace.package.version` in `Cargo.toml`, and bump any npm
   package whose contents changed. Move the contract line **only** if a closed wire
   vocabulary changed; that is a breaking change for every peer.
3. Write the `CHANGELOG.md` entry.
4. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow then verifies before it publishes anything, at the exact commit the tag names:
`cargo fmt`, `clippy`, the full test suite, both policy scripts, the whole web pipeline, the
`wasm32-unknown-unknown` build a product's browser artifact depends on, and `cargo deny`.
That is everything the pull-request workflows run, which is what makes "nothing reaches a
registry that was not checked at that commit" a statement rather than a hope.

Re-running a release is safe. `scripts/publish_packages.sh` skips a version already present
in the target registry rather than retrying it into an error.

## Registries

| Registry | When it runs | What a consumer needs |
|---|---|---|
| Public npm | when the `NPM_TOKEN` secret is set | nothing |
| GitHub Packages | when the package scope matches the repository owner | an `.npmrc` naming the scope |

Each condition is reported as a workflow notice, so a release names which registry it could
not reach and why. **Reaching neither is a failure**, not a notice: a release that ran green
and published no installable package would be a false success, so the guard stops there
rather than tagging a version nobody can install.

That is the state today — `NPM_TOKEN` is unset and the scope does not match the owner — so
cutting `v0.2.0` right now fails at the guard until one of the two decisions below is made.

**The scope is currently a constraint.** GitHub Packages resolves an npm scope to the
repository owner and accepts only `@<owner>/*`. The packages are `@aiaiaiai/*` and the
owner is `aiaiaiai-org`, so GitHub Packages will decline them as named. Two ways forward,
and it is a naming decision rather than a technical one:

- Keep `@aiaiaiai/*` and publish to the public npm registry only. Set `NPM_TOKEN` in the
  repository secrets, from an npm account that owns the `@aiaiaiai` organization.
- Rename to `@aiaiaiai-org/*`, which both registries accept. Every consumer import changes
  with it, so this is cheapest before the first consumer exists.

Set `NPM_TOKEN` under **Settings → Secrets and variables → Actions**. Nothing else in the
release path needs a secret: GitHub Packages, when it applies, uses the workflow's own
`GITHUB_TOKEN`.

## What a consumer writes

### A Rust product runtime

```toml
[dependencies]
aiai-runtime = { git = "https://github.com/aiaiaiai-org/artificial-intelligence.git", tag = "v0.2.0" }
```

A tag is fixed; a branch moves, so the build that passed yesterday is not the build that
runs today. Before the first tag exists, pin a `rev` reachable from `master` instead.

### A host client

```sh
npm install @aiaiaiai/contracts   # the wire contract it renders
npm install @aiaiaiai/webllm      # only if it runs a model locally
```

From GitHub Packages, the consumer adds an `.npmrc` first:

```ini
@aiaiaiai:registry=https://npm.pkg.github.com
```

and authenticates with a token that has `read:packages`. The public registry needs neither.

## Related

- [Consuming the foundation](consuming.md) — the port, failure, and pinning contract
- [The host side of the contract](host-contract.md)
- [CHANGELOG](../CHANGELOG.md)
