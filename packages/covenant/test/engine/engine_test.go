// Executes the hand-committed v2 vectors in the emulator's arkade engine, through
// the ReadArkadeScript -> Execute path its SubmitTx uses. Run via run.mjs.
package taxiv2_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/btcutil/psbt"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/btcsuite/btcd/txscript"
	"github.com/btcsuite/btcd/wire"
	"github.com/stretchr/testify/require"
)

const (
	leafRecycle = 0
	leafRefund  = 2
	leafReclaim = 3
	coinSats    = int64(1000)
)

type vector struct {
	Name   string `json:"name"`
	Params struct {
		ReceiverKey          string  `json:"receiverKey"`
		OperatorKey          string  `json:"operatorKey"`
		Dust                 int64   `json:"dust"`
		Topup                int64   `json:"topup"`
		PaymentSats          int64   `json:"paymentSats"`
		AssetTxid            *string `json:"assetTxid"`
		AssetIndex           uint16  `json:"assetIndex"`
		ReceiverFareCurrency *string `json:"receiverFareCurrency"`
		ReceiverFareUnits    uint64  `json:"receiverFareUnits"`
	} `json:"params"`
	Recycle  string   `json:"recycle"`
	Refund   string   `json:"refund"`
	Reclaim  string   `json:"reclaim"`
	Leaves   []string `json:"leaves"`
	PkScript string   `json:"pkScript"`
}

type fixture struct {
	ServerKey   string   `json:"serverKey"`
	EmulatorKey string   `json:"emulatorKey"`
	Cases       []vector `json:"cases"`
}

func load(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile(os.Getenv("TAXI_V2_VECTORS"))
	require.NoError(t, err)
	var f fixture
	require.NoError(t, json.Unmarshal(raw, &f))
	require.NotEmpty(t, f.Cases)
	return f
}

func decode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	require.NoError(t, err)
	return b
}

func pubkey(t *testing.T, s string) *btcec.PublicKey {
	t.Helper()
	k, err := schnorr.ParsePubKey(decode(t, s))
	require.NoError(t, err)
	return k
}

func p2tr(xonly []byte) []byte {
	return append([]byte{txscript.OP_1, txscript.OP_DATA_32}, xonly...)
}

// A wallet coin's script is its tree's tweaked key, never the bare identity key
// that senderKey is, so the refunder's coin here is deliberately unrelated to it.
func walletScript(seed byte) []byte {
	priv, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{seed}, 32))
	return p2tr(schnorr.SerializePubKey(priv.PubKey()))
}

type fetcher struct{ txscript.PrevOutputFetcher }

func (fetcher) FetchPrevOutArkTx(wire.OutPoint) *wire.MsgTx { return nil }

func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	if prev := f.FetchPrevOutput(op); prev != nil {
		return prev.PkScript
	}
	return nil
}

// assetIn[i] and assetOut[i] are the units at input or output i; zero is absent.
type spend struct {
	ins, outs         []*wire.TxOut
	assetIn, assetOut []uint64
}

func (s spend) clone() spend {
	c := spend{
		assetIn:  append([]uint64(nil), s.assetIn...),
		assetOut: append([]uint64(nil), s.assetOut...),
	}
	for _, o := range s.ins {
		cp := *o
		c.ins = append(c.ins, &cp)
	}
	for _, o := range s.outs {
		cp := *o
		c.outs = append(c.outs, &cp)
	}
	return c
}

func assetPacket(t *testing.T, v vector, s spend) asset.Packet {
	t.Helper()
	var txid chainhash.Hash
	copy(txid[:], decode(t, *v.Params.AssetTxid))
	id := asset.AssetId{Txid: txid, Index: v.Params.AssetIndex}
	var ins []asset.AssetInput
	for i, units := range s.assetIn {
		if units > 0 {
			in, err := asset.NewAssetInput(uint16(i), units)
			require.NoError(t, err)
			ins = append(ins, *in)
		}
	}
	var outs []asset.AssetOutput
	for i, units := range s.assetOut {
		if units > 0 {
			out, err := asset.NewAssetOutput(uint16(i), units)
			require.NoError(t, err)
			outs = append(outs, *out)
		}
	}
	group, err := asset.NewAssetGroup(&id, nil, ins, outs, []asset.Metadata{})
	require.NoError(t, err)
	packet, err := asset.NewPacket([]asset.AssetGroup{*group})
	require.NoError(t, err)
	return packet
}

func run(t *testing.T, f fixture, v vector, leaf, script []byte, s spend) error {
	t.Helper()
	tx := wire.NewMsgTx(2)
	prevouts := make(map[wire.OutPoint]*wire.TxOut, len(s.ins))
	for i, in := range s.ins {
		op := wire.OutPoint{Hash: chainhash.Hash{byte(i + 1)}}
		tx.AddTxIn(wire.NewTxIn(&op, nil, nil))
		prevouts[op] = in
	}
	for _, out := range s.outs {
		tx.AddTxOut(out)
	}
	entry := arkade.EmulatorEntry{Vin: 0, Script: script}
	ext := extension.Extension{arkade.EmulatorPacket{entry}}
	if v.Params.AssetTxid != nil {
		ext = append(extension.Extension{assetPacket(t, v, s)}, ext...)
	}
	extOut, err := ext.TxOut()
	require.NoError(t, err)
	tx.AddTxOut(extOut)

	ptx, err := psbt.NewFromUnsignedTx(tx)
	require.NoError(t, err)
	ptx.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{
		{Script: leaf, LeafVersion: txscript.BaseLeafVersion},
	}
	program, err := arkade.ReadArkadeScript(ptx, pubkey(t, f.EmulatorKey), entry)
	if err != nil {
		return err
	}
	return program.Execute(tx, fetcher{txscript.NewMultiPrevOutFetcher(prevouts)}, 0)
}

// Index and stack errors mean the script aborted before the condition under test.
func requireRejected(t *testing.T, err error) {
	t.Helper()
	var scriptErr txscript.Error
	require.ErrorAs(t, err, &scriptErr, "expected a script error, got %v", err)
	require.Contains(t, []txscript.ErrorCode{
		txscript.ErrEvalFalse, txscript.ErrVerify, txscript.ErrEqualVerify, txscript.ErrNumEqualVerify,
	}, scriptErr.ErrorCode, "aborted instead of evaluating false: %v", err)
}

func lockup(v vector) int64 { return v.Params.Dust + v.Params.PaymentSats }

func operatorScript(t *testing.T, v vector) []byte {
	return p2tr(decode(t, v.Params.OperatorKey))
}

func twoInputs(t *testing.T, v vector, coin []byte, repaid int64) spend {
	return spend{
		ins: []*wire.TxOut{
			{Value: lockup(v), PkScript: decode(t, v.PkScript)},
			{Value: coinSats, PkScript: coin},
		},
		outs: []*wire.TxOut{
			{Value: repaid, PkScript: operatorScript(t, v)},
			{Value: lockup(v) + coinSats - repaid, PkScript: coin},
		},
		assetIn:  []uint64{7, 20},
		assetOut: []uint64{0, 27},
	}
}

func multisig(t *testing.T, keys ...*btcec.PublicKey) []byte {
	t.Helper()
	s, err := (&scriptlib.MultisigClosure{PubKeys: keys}).Script()
	require.NoError(t, err)
	return s
}

// The v2 refund rests on this: input 1's value reads the same in the
// sender-signed refund leaf as in the recycle leaf.
func TestInputOneValue(t *testing.T) {
	f := load(t)
	for _, v := range f.Cases {
		t.Run(v.Name, func(t *testing.T) {
			refund := decode(t, v.Refund)
			cases := map[string]struct {
				leaf, script []byte
				valid        spend
			}{
				"refund": {decode(t, v.Leaves[leafRefund]), refund, twoInputs(t, v, walletScript(9), v.Params.Topup)},
				"refund under recycle's signer set": {
					multisig(t, pubkey(t, f.ServerKey), arkade.ComputeArkadeScriptPublicKey(
						pubkey(t, f.EmulatorKey), arkade.ArkadeScriptHash(refund))),
					refund, twoInputs(t, v, walletScript(9), v.Params.Topup),
				},
			}
			if v.Params.ReceiverFareCurrency == nil {
				cases["recycle"] = struct {
					leaf, script []byte
					valid        spend
				}{decode(t, v.Leaves[leafRecycle]), decode(t, v.Recycle),
					twoInputs(t, v, p2tr(decode(t, v.Params.ReceiverKey)), v.Params.Topup)}
			}
			for name, c := range cases {
				t.Run(name, func(t *testing.T) {
					require.NoError(t, run(t, f, v, c.leaf, c.script, c.valid))

					larger := c.valid.clone()
					larger.ins[1].Value += 4000
					larger.outs[1].Value += 4000
					require.NoError(t, run(t, f, v, c.leaf, c.script, larger))

					drifted := c.valid.clone()
					drifted.ins[1].Value++
					requireRejected(t, run(t, f, v, c.leaf, c.script, drifted))
				})
			}
		})
	}
}

// TestInputOneValue skips recycle under a fare, so without this the asset-fare
// branch of the recycle covenant is never executed — and it is the clause that
// decides how much of the asset the operator may take.
func TestRecycleAssetFare(t *testing.T) {
	f := load(t)
	for _, v := range f.Cases {
		if v.Params.ReceiverFareCurrency == nil || *v.Params.ReceiverFareCurrency != "asset" {
			continue
		}
		t.Run(v.Name, func(t *testing.T) {
			leaf, script := decode(t, v.Leaves[leafRecycle]), decode(t, v.Recycle)
			fare, held := v.Params.ReceiverFareUnits, uint64(27)
			require.NotZero(t, fare)
			valid := twoInputs(t, v, p2tr(decode(t, v.Params.ReceiverKey)), v.Params.Topup)
			valid.assetOut = []uint64{fare, held - fare}
			require.NoError(t, run(t, f, v, leaf, script, valid))

			// fare_withheld is unbalanced on purpose: out[1] satisfies the
			// in[0]+in[1]-fare equation exactly, so only the fare clause itself
			// can reject it. Balanced, conservation already implies out[0].
			for name, outs := range map[string][]uint64{
				"fare_short":    {fare - 1, held - fare + 1},
				"fare_withheld": {0, held - fare},
			} {
				t.Run(name, func(t *testing.T) {
					c := valid.clone()
					c.assetOut = outs
					requireRejected(t, run(t, f, v, leaf, script, c))
				})
			}
		})
	}
}

func TestRefund(t *testing.T) {
	f := load(t)
	for _, v := range f.Cases {
		t.Run(v.Name, func(t *testing.T) {
			leaf, script := decode(t, v.Leaves[leafRefund]), decode(t, v.Refund)
			valid := twoInputs(t, v, walletScript(9), v.Params.Topup)
			reject := func(name string, mutate func(*spend)) {
				t.Run(name, func(t *testing.T) {
					c := valid.clone()
					mutate(&c)
					requireRejected(t, run(t, f, v, leaf, script, c))
				})
			}
			reject("refund_to_another_script", func(c *spend) { c.outs[1].PkScript = walletScript(8) })
			reject("operator_short", func(c *spend) { c.outs[0].Value--; c.outs[1].Value++ })
			reject("operator_wrong_key", func(c *spend) { c.outs[0].PkScript = walletScript(8) })
			reject("third_input", func(c *spend) {
				c.ins = append(c.ins, &wire.TxOut{Value: coinSats, PkScript: walletScript(9)})
			})
			if v.Params.AssetTxid == nil {
				return
			}
			reject("asset_to_operator", func(c *spend) { c.assetOut = []uint64{1, 26} })
			t.Run("refunder_holds_none_of_the_asset", func(t *testing.T) {
				c := valid.clone()
				c.assetIn, c.assetOut = []uint64{7}, []uint64{0, 7}
				require.NoError(t, run(t, f, v, leaf, script, c))
			})
		})
	}
}

func TestReclaim(t *testing.T) {
	f := load(t)
	for _, v := range f.Cases {
		t.Run(v.Name, func(t *testing.T) {
			leaf, script := decode(t, v.Leaves[leafReclaim]), decode(t, v.Reclaim)
			valid := spend{
				ins:      []*wire.TxOut{{Value: lockup(v), PkScript: decode(t, v.PkScript)}},
				outs:     []*wire.TxOut{{Value: lockup(v), PkScript: operatorScript(t, v)}},
				assetIn:  []uint64{7},
				assetOut: []uint64{7},
			}
			require.NoError(t, run(t, f, v, leaf, script, valid))

			err := run(t, f, v, leaf, decode(t, v.Refund), valid)
			require.True(t, errors.Is(err, arkade.ErrTweakedArkadePubKeyNotFound), "got %v", err)

			stranger := valid.clone()
			stranger.ins = append(stranger.ins, &wire.TxOut{Value: coinSats, PkScript: walletScript(8)})
			stranger.outs = append(stranger.outs, &wire.TxOut{Value: coinSats, PkScript: walletScript(8)})
			require.NoError(t, run(t, f, v, leaf, script, stranger))

			for name, mutate := range map[string]func(*spend){
				"short":          func(c *spend) { c.outs[0].Value-- },
				"wrong_key":      func(c *spend) { c.outs[0].PkScript = walletScript(8) },
				"stranger_skims": func(c *spend) { c.outs[0].Value -= 10; c.outs[1].Value += 10 },
				"asset_short":    func(c *spend) { c.assetOut = []uint64{6, 1} },
			} {
				if name == "asset_short" && v.Params.AssetTxid == nil {
					continue
				}
				t.Run(name, func(t *testing.T) {
					c := stranger.clone()
					mutate(&c)
					requireRejected(t, run(t, f, v, leaf, script, c))
				})
			}
		})
	}
}
