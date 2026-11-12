import Link from "next/link";

const steps: [string, string][] = [
  ["there is one crown.", "whoever holds it is the king. the king is paid 95% of the creator fees from every $CROWN trade, about once a minute, for as long as they hold it."],
  ["anyone can take it, any time.", "you pay the price on the front page. 90% goes straight to the king you are replacing. 10% is burned: it is used to buy $CROWN and destroy it."],
  ["the price jumps when it is taken.", "the new price is 1.3 to 1.6 times what you paid. the exact number is random, so nobody can time it perfectly."],
  ["then it melts.", "the price falls every second: 2% a minute when trading volume is rising, 4% when it is flat, 8% when it is falling. the slower the trading, the faster the crown gets cheap."],
  ["it never melts to nothing.", "the price stops at a floor worth about 10 minutes of the fees the crown is earning right now."],
  ["so you win two ways.", "you earn fees while you hold it, and you get paid when someone takes it from you. if they take it soon after you did, you get back more than you paid."],
];

export default function How() {
  return (
    <>
      <h1 className="text-center text-xl font-semibold">how it works</h1>
      <ol className="flex flex-col gap-3">
        {steps.map(([head, body], i) => (
          <li key={head} className="rounded bg-card px-4 py-3 text-sm">
            <span className="num text-muted">{i + 1}. </span>
            <span className="font-semibold">{head}</span> <span className="text-muted">{body}</span>
          </li>
        ))}
      </ol>
      <section className="flex flex-col gap-2 text-xs text-muted">
        <h2 className="text-sm text-white">the fine print, in plain words</h2>
        <p>5% of creator fees go to the developer wallet. the split is set on pump.fun and the team cannot change it afterwards. pump.fun itself still controls its own programs and could.</p>
        <p>every number here (the jump, the melt rates, the burn, the floor) is fixed in the program and cannot be changed once it is locked. the front page shows whether it is locked.</p>
        <p>you can lose money. if nobody takes the crown from you, you keep earning fees but you do not get your price back. only pay what you are fine not getting back.</p>
      </section>
      <p className="text-center"><Link className="br text-sm" href="/">[take the crown]</Link></p>
    </>
  );
}
