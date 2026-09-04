# @aiaiaiai/contracts

The host side of the aiaiaiai AI foundation wire contract `0.2.0`. Zero runtime
dependencies.

A product AI runtime speaks this contract from Rust. The client that renders a turn
usually does not, and the contract's rules hold only if both ends keep them: integers
travel as decimal strings so a JavaScript host cannot narrow one through IEEE-754, the
failure taxonomy is closed, envelopes are closed, an identifier is canonical or refused.
`JSON.parse` keeps none of that.

```sh
npm install @aiaiaiai/contracts
```

```ts
import {
  decodeCanonicalJson,
  decodeTurnOutcome,
  requireCompatibleContract,
} from "@aiaiaiai/contracts";

requireCompatibleContract(peerContractVersion); // before anything is decoded

const outcome = decodeTurnOutcome(
  decodeCanonicalJson(payload),
  decodeProductProposal, // the product owns what a proposal means
  decodeProductEffect,
);

if ("error" in outcome) {
  reportDegraded(outcome.error.code); // a failure is an outcome, never an empty success
} else {
  for (const proposal of outcome.ok.proposals) {
    render(proposal.proposal); // computation awaiting a decision, not an action
  }
}
```

This package decodes and encodes. It holds no session state and takes no authority
decision, so a proposal it decoded is a proposal until the runtime that owns it is told
otherwise.

Both implementations of the contract — these types and the Rust crates they mirror —
answer one shared corpus, so a mirror that drifts fails a build rather than a payload.

The package version is the contract line it implements: `0.2.0` speaks `0.2.0` and
nothing else.

- [The host side of the contract](https://github.com/aiaiaiai-org/artificial-intelligence/blob/master/docs/host-contract.md)
- [Foundation architecture](https://github.com/aiaiaiai-org/artificial-intelligence/blob/master/docs/architecture.md)

Licensed under Apache-2.0. See `LICENSE` and `NOTICE`.
