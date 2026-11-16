import type { NextConfig } from "next";

// Headers for the machine-facing surface. The same policy is also applied inside the /mcp pipeline,
// so the SDK's own responses carry it even if this config is bypassed.
const apiHeaders = [
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker deployment (Phase 9).
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/mcp", headers: apiHeaders },
      { source: "/api/:path*", headers: apiHeaders },
      // The landing page: no framing, no sniffing.
      { source: "/", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
