"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { confirmTake, getTakeTx } from "@/lib/api";
import { maxPriceFor, sol } from "@/lib/price";

const SLIPPAGE_CHOICES = [50, 100, 300]; // bps

type Status =
  | { kind: "idle" }
  | { kind: "working"; text: string }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

/** Turns wallet, RPC and program errors into one plain sentence. */
function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(msg)) return "you cancelled the transaction in your wallet.";
  if (/PriceAboveMax|0x1772/.test(msg)) return "the price moved above your limit (someone may have just taken it). nothing was paid. try again.";
  if (/insufficient|0x1\b/i.test(msg)) return "not enough SOL in this wallet for the price plus fees.";
  if (/expired|block height/i.test(msg)) return "the transaction took too long and expired. nothing was paid. try again.";
  return `the transaction failed: ${msg.split("\n")[0].slice(0, 160)}`;
}

export function TakeButton({ price, isKing, onTaken }: { price: bigint | null; isKing: boolean; onTaken: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const [slippage, setSlippage] = useState(100);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const maxPrice = price === null ? null : maxPriceFor(price, slippage);
  const busy = status.kind === "working";

  async function take() {
    if (!publicKey) return setVisible(true);
    if (maxPrice === null) return;
    try {
      setStatus({ kind: "working", text: "building the transaction…" });
      const built = await getTakeTx(publicKey.toBase58(), maxPrice);
      const decode = (b64: string) => VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      const tx = decode(built.transaction);
      setStatus({ kind: "working", text: "approve it in your wallet…" });
      // After graduation a takeover also triggers the buyback-and-burn: both
      // are signed in one approval, the burn is sent once the takeover lands.
      let signature: string;
      let burn: VersionedTransaction | null = null;
      if (built.burn && signAllTransactions) {
        const [take, b] = await signAllTransactions([tx, decode(built.burn)]);
        signature = await connection.sendRawTransaction(take.serialize());
        burn = b;
      } else {
        signature = await sendTransaction(tx, connection);
      }
      setStatus({ kind: "working", text: "waiting for the network…" });
      const res = await connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      // The burn is a bonus: if it fails (cooldown, price moved), the takeover stands.
      if (burn) await connection.sendRawTransaction(burn.serialize()).catch(() => undefined);
      await confirmTake(); // server-run game: read the payment now rather than on its next pass
      setStatus({ kind: "done", text: "the crown is yours." });
      onTaken();
    } catch (e) {
      setStatus({ kind: "error", text: explain(e) });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={take}
        disabled={busy || price === null}
        className="w-full rounded bg-mint px-6 py-3 text-lg font-semibold text-bg disabled:opacity-60"
      >
        {busy ? "[taking…]" : isKing ? "[fortify the crown]" : "[take the crown]"}
      </button>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="num">
          you pay at most <span className="text-mint">{maxPrice === null ? "…" : sol(maxPrice, 4)} SOL</span>
        </span>
        <span role="group" aria-label="price limit" className="flex items-center gap-2">
          limit
          {SLIPPAGE_CHOICES.map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippage(bps)}
              aria-pressed={slippage === bps}
              className={slippage === bps ? "text-white underline" : "br"}
            >
              +{bps / 100}%
            </button>
          ))}
        </span>
      </div>
      {isKing && status.kind === "idle" && (
        <p className="text-center text-xs text-muted">
          you hold the crown. taking it again costs you the 10% burn and resets the price higher.
        </p>
      )}
      {status.kind !== "idle" && (
        <p role="status" className={`text-center text-sm ${status.kind === "error" ? "text-red" : status.kind === "done" ? "text-mint" : "text-muted"}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}
