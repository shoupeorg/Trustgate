import type { NextConfig } from "next";

// Set when building for the main domain: the old workers.dev URL then redirects pages there. API routes are not redirected, so existing MCP clients keep working.
const canonicalHost = process.env.CANONICAL_HOST;

const nextConfig: NextConfig = {
  env: {
    // The V1 deal inspector at /v1 talks to the untouched V1 contract (public address, not a secret).
    NEXT_PUBLIC_TRUSTGATE_CONTRACT_ADDRESS: process.env.NEXT_PUBLIC_TRUSTGATE_CONTRACT_ADDRESS ?? "0xf6F2108C8eD388699F382203b6eb93F6DC8a6584",
  },
  async redirects() {
    if (!canonicalHost) return [];
    const host = [{ type: "host" as const, value: "trustgate-v13.shoupeorg.workers.dev" }];
    // "/" gets its own rule: an empty :path in the destination made OpenNext answer 500.
    return [
      { source: "/", has: host, destination: `https://${canonicalHost}/`, permanent: false },
      { source: "/:path((?!api/).+)", has: host, destination: `https://${canonicalHost}/:path`, permanent: false },
    ];
  },
};

export default nextConfig;
