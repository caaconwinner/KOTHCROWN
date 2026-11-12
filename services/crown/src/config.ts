import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
};

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const rpcUrl = () => env("RPC_URL");
export const connection = () => new Connection(rpcUrl(), "confirmed");
export const mint = () => new PublicKey(env("MINT"));
export const keypair = (): Keypair => {
  const path = env("KEYPAIR").replace(/^~/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
};
export const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
export const str = env;

export async function isMainnet(conn: Connection): Promise<boolean> {
  return (await conn.getGenesisHash()) === MAINNET_GENESIS;
}
