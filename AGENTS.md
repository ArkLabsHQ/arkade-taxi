# AGENTS.md

Working notes for anyone — human or agent — changing this repository.

## Gates

```
pnpm -r build
pnpm typecheck
pnpm test
pnpm format:check
```

Run all four. `build` passing while `typecheck` fails, and the reverse, both
happen.

## The covenant comes from the compiler

`packages/covenant/contracts/dust_covenant.ark` is the source. `pnpm artifact`
uses the digest-pinned compiler in `scripts/get-arkadec.mjs` to regenerate the
committed JSON and browser module. Runtime code loads that artifact through
`programFromArtifact` and `ArkadeProgramScript`; do not hand-build its scripts
or edit generated artifacts.

After a contract change, regenerate the artifacts and verify the diff. Run
`node packages/covenant/test/engine/run.mjs` to execute the committed vectors
against their pinned emulator engine. Update vectors only for an intentional
contract change, with the reason in the commit message.

## Never assemble the taproot tree by hand

`VtxoScript` uses btcd's `AssembleTaprootScriptTree`. `@scure/btc-signer`'s
default `taprootListToTree` is a Huffman builder that only agrees with arkd for
power-of-2 leaf counts. The covenant has six leaves, so the Huffman builder would
silently derive a different address. `test/taptree.test.ts` guards this.
`Leaf` in `packages/covenant/src/vtxo.ts` fixes their order: recycle, purchase,
refund, reclaim, exit, renew. Preserve that order when loading compiler groups.

## Comments

10% of added lines, maximum — tests included. History and design rationale belong
in the commit message.

## Line endings

`.gitattributes` pins `* text=auto eol=lf`. Do not put `endOfLine` in
`.prettierrc`: it silences the check locally while CI keeps enforcing LF.
