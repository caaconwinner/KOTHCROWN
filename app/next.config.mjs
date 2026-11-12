/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are TypeScript source. The browser only ever imports
  // the SDK's pure math file (src/lib/price.ts). The API route (server only)
  // imports the services package, which uses pump.fun's SDK.
  transpilePackages: ["@koth-crown/sdk", "@koth-crown/services"],
  // Loaded with require() at runtime instead of being bundled: pump.fun's SDK
  // has a dependency whose ES-module build is broken, and its CommonJS build works.
  serverExternalPackages: ["@pump-fun/pump-sdk", "@pump-fun/pump-swap-sdk", "@coral-xyz/anchor"],
};
export default nextConfig;
