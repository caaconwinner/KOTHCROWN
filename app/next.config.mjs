/** @type {import('next').NextConfig} */
const nextConfig = {
  // The SDK is TypeScript source in the workspace. Only its pure math file is
  // imported here (see src/lib/price.ts), never the pump.fun parts.
  transpilePackages: ["@koth-crown/sdk"],
};
export default nextConfig;
