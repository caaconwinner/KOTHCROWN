import Link from "next/link";
import { CrownGauge } from "./CrownGauge";

const TWITTER = process.env.NEXT_PUBLIC_TWITTER_URL;
const TELEGRAM = process.env.NEXT_PUBLIC_TELEGRAM_URL;

/**
 * Shown until an indexer API is configured (NEXT_PUBLIC_API_URL). No numbers
 * here: there is no coin yet, so there is nothing true to show.
 */
export function PreLaunch() {
  return (
    <section className="flex flex-col items-center gap-8 pt-4 text-center">
      <CrownGauge fraction={1} heat="gold" className="w-44" />
      <h1 className="max-w-md text-2xl font-semibold sm:text-3xl">the crown gets cheaper every minute.</h1>
      <ul className="flex flex-col gap-1 text-muted">
        <li>take it.</li>
        <li>earn the fees.</li>
        <li>get paid when someone takes it from you.</li>
      </ul>
      <p className="rounded bg-card px-4 py-2 text-sm">
        <span className="text-gold">$CROWN</span> is not live yet. there is no coin to buy and no crown to take.
      </p>
      <nav className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm">
        <Link className="br" href="/how">[how it works]</Link>
        {TWITTER && <a className="br" href={TWITTER} target="_blank" rel="noreferrer">[twitter]</a>}
        {TELEGRAM && <a className="br" href={TELEGRAM} target="_blank" rel="noreferrer">[telegram]</a>}
      </nav>
    </section>
  );
}
