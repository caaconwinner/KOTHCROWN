"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LIVE } from "@/lib/api";
import { short } from "@/lib/price";

const TWITTER = process.env.NEXT_PUBLIC_TWITTER_URL;
const TELEGRAM = process.env.NEXT_PUBLIC_TELEGRAM_URL;

export function TopBar() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  return (
    <header className="flex flex-col gap-4">
      <nav className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {TWITTER && <a className="br" href={TWITTER} target="_blank" rel="noreferrer">[twitter]</a>}
          {TELEGRAM && <a className="br" href={TELEGRAM} target="_blank" rel="noreferrer">[telegram]</a>}
          <Link className="br" href="/how">[how it works]</Link>
          {LIVE && <Link className="br" href="/kings">[hall of kings]</Link>}
        </div>
        {!LIVE ? null : publicKey ? (
          <button className="br" onClick={() => disconnect()} title="disconnect">
            [<span className="text-sky">{short(publicKey.toBase58())}</span> · disconnect]
          </button>
        ) : (
          <button className="br" onClick={() => setVisible(true)} disabled={connecting}>
            {connecting ? "[connecting…]" : "[connect wallet]"}
          </button>
        )}
      </nav>
      <Link href="/" aria-label="take the crown, home" className="self-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark.svg" alt="crown" width={190} height={74} className="h-auto w-[190px]" />
      </Link>
    </header>
  );
}
