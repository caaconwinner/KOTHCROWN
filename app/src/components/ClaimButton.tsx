"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { getClaimTx } from "@/lib/api";

/** The king's button: pays out the fees waiting for them. Until they press it the fees wait safely; a takeover pays them out too. */
export function ClaimButton({ onClaimed }: { onClaimed: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "error"; text: string }>({ kind: "idle", text: "" });

  async function claim() {
    if (!publicKey) return;
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
        {status.kind === "working" ? "[claiming…]" : "[claim fees]"}
      </button>
      <p role="status" className={`text-center text-xs ${status.kind === "error" ? "text-red" : status.kind === "done" ? "text-mint" : "text-muted"}`}>
        {status.kind === "idle" ? "your fees wait until you claim them. a takeover pays them out too." : status.text}
      </p>
    </div>
  );
}
