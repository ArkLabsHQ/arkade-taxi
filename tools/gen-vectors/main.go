// Command gen-vectors emits golden script vectors from the Go covenant
// reference so the TypeScript port can be asserted byte-for-byte against it.
//
// It is copied into the emulator checkout before running, so it resolves
// against that module's dependency graph rather than a replace directive.
package main

import (
	"encoding/hex"
	"encoding/json"
	"os"

	arklib "github.com/arkade-os/arkd/pkg/ark-lib"
	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/emulator/test/covenant"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

const reference = "49ae96d0241e7672e40b25543875538d4373fb80"

type jsonParams struct {
	ReceiverKey string  `json:"receiverKey"`
	SenderKey   string  `json:"senderKey"`
	OperatorKey string  `json:"operatorKey"`
	Dust        int64   `json:"dust"`
	Topup       int64   `json:"topup"`
	AssetTxid   *string `json:"assetTxid"`
	AssetIndex  *uint16 `json:"assetIndex"`
	Locktime    uint32  `json:"locktime"`
}

type vector struct {
	Name          string     `json:"name"`
	Params        jsonParams `json:"params"`
	VtxoMinAmount int64      `json:"vtxoMinAmount"`
	Recycle       string     `json:"recycle"`
	Purchase      string     `json:"purchase"`
	Refund        string     `json:"refund"`
}

// Derived from a fixed scalar rather than raw bytes, which are not guaranteed
// to land on the curve.
func key(fill byte) *btcec.PublicKey {
	var b [32]byte
	for i := range b {
		b[i] = fill
	}
	priv, _ := btcec.PrivKeyFromBytes(b[:])
	return priv.PubKey()
}

func xonly(k *btcec.PublicKey) string {
	return hex.EncodeToString(schnorr.SerializePubKey(k))
}

type spec struct {
	name    string
	dust    int64
	topup   int64
	min     int64
	assetID *asset.AssetId
}

func main() {
	out := os.Args[1]

	receiver, sender, operator := key(0x01), key(0x02), key(0x03)

	var assetID asset.AssetId
	for i := range assetID.Txid {
		assetID.Txid[i] = 0x11
	}

	// Chosen to exercise both pinOutput branches and the minimal-push
	// boundaries where Go's txscript and TypeScript's BigNum are most likely to
	// disagree.
	specs := []spec{
		{"btc-topup-full", 330, 330, 10, nil},
		{"btc-topup-partial", 330, 300, 10, nil},
		{"btc-topup-min", 330, 1, 1, nil},
		{"btc-topup-16", 330, 16, 16, nil},
		{"btc-topup-17", 330, 17, 17, nil},
		{"btc-dust-large", 100000, 50000, 10, nil},
		{"asset-topup-full", 330, 330, 10, &assetID},
		{"asset-topup-partial", 330, 300, 10, &assetID},
		{"asset-topup-min", 330, 1, 1, &assetID},
		{"asset-dust-large", 100000, 50000, 10, &assetID},
	}

	doc := struct {
		Reference string   `json:"reference"`
		Cases     []vector `json:"cases"`
	}{Reference: reference}

	for _, s := range specs {
		p := covenant.Params{
			ReceiverKey: receiver,
			SenderKey:   sender,
			OperatorKey: operator,
			Dust:        s.dust,
			Topup:       s.topup,
			AssetID:     s.assetID,
			Locktime:    arklib.AbsoluteLocktime(800000),
		}
		scripts, err := covenant.Build(p, s.min)
		if err != nil {
			panic(err)
		}

		jp := jsonParams{
			ReceiverKey: xonly(receiver),
			SenderKey:   xonly(sender),
			OperatorKey: xonly(operator),
			Dust:        s.dust,
			Topup:       s.topup,
			Locktime:    800000,
		}
		if s.assetID != nil {
			t := hex.EncodeToString(s.assetID.Txid[:])
			i := s.assetID.Index
			jp.AssetTxid, jp.AssetIndex = &t, &i
		}

		doc.Cases = append(doc.Cases, vector{
			Name:          s.name,
			Params:        jp,
			VtxoMinAmount: s.min,
			Recycle:       hex.EncodeToString(scripts.Recycle),
			Purchase:      hex.EncodeToString(scripts.Purchase),
			Refund:        hex.EncodeToString(scripts.Refund),
		})
	}

	f, err := os.Create(out)
	if err != nil {
		panic(err)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		panic(err)
	}
}
