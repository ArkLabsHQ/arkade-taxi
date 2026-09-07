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

## The covenant is ported, not authored

`packages/dust-covenant` is a TypeScript port of `test/covenant/covenant.go` in
arkade-os/emulator#150, which was executed against a live emulator and arkd. The
Go implementation is the reference. `test/vectors.json` is generated from it and
asserted byte-for-byte.

If you change a script builder and the vector test fails, the port is wrong —
not the vectors. Regenerate vectors only when the Go reference itself changed,
and say so in the commit message.

## Never assemble the taproot tree by hand

`VtxoScript` uses btcd's `AssembleTaprootScriptTree`. `@scure/btc-signer`'s
default `taprootListToTree` is a Huffman builder that only agrees with arkd for
power-of-2 leaf counts. The covenant has 4 leaves today, so both happen to work;
splitting the shared refund leaf would make it 5 and silently change the address.
`test/taptree.test.ts` guards this.

## Comments

10% of added lines, maximum — tests included. History and design rationale belong
in the commit message.

## Line endings

`.gitattributes` pins `* text=auto eol=lf`. Do not put `endOfLine` in
`.prettierrc`: it silences the check locally while CI keeps enforcing LF.
