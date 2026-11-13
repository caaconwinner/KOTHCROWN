"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { claimFees, getClaimTx } from "@/lib/api";
import { sol } from "@/lib/price";

/** The king's button: pays out the fees waiting for them. Until they press it the fees wait safely; a takeover pays them out too. */
export function ClaimButton({ onClaimed, owed, serverRun }: { onClaimed: () => void; owed?: string; serverRun: boolean }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "error"; text: string }>({ kind: "idle", text: "" });

  async function claim() {
    if (!publicKey) return;
    if (serverRun) {
      // The game server pays the fees to this wallet: nothing to sign.
      try {
        setStatus({ kind: "working", text: "sending your fees…" });
        const { lamports } = await claimFees(publicKey.toBase58());
        setStatus({ kind: "done", text: BigInt(lamports) > 0n ? `${sol(BigInt(lamports), 4)} SOL is on its way to your wallet.` : "nothing to claim yet." });
        onClaimed();
      } catch (e) {
        setStatus({ kind: "error", text: `claim failed: ${e instanceof Error ? e.message.slice(0, 120) : e}` });
      }
      return;
    }
    try {
      setStatus({ kind: "working", text: "approve it in your wallet…" });
      const built = await getClaimTx(publicKey.toBase58());
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(built.transaction), (c) => c.charCodeAt(0)));
      const signature = await sendTransaction(tx, connection);
      const res = await connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      setStatus({ kind: "done", text: "fees sent to your wallet." });
      onClaimed();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", text: /reject|denied|cancel/i.test(msg) ? "you cancelled it in your wallet." : `claim failed: ${msg.split("\n")[0].slice(0, 120)}` });
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button onClick={claim} disabled={status.kind === "working"} className="br text-sm disabled:opacity-60">
        {status.kind === "working" ? "[claiming…]" : owed && BigInt(owed) > 0n ? `[claim ${sol(BigInt(owed), 4)} SOL]` : "[claim]"}
      </button>
      <p role="status" className={`text-center text-xs ${status.kind === "error" ? "text-red" : status.kind === "done" ? "text-mint" : "text-muted"}`}>
        {status.kind === "idle" ? "" : status.text}
      </p>
    </div>
  );
}
