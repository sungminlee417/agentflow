import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentflow/core"],
  // Allow ngrok / tunnel hosts to make cross-origin dev requests
  // (HMR, fast-refresh, etc.) so React hydration works through ngrok.
  // For local dev only — production uses the deployed origin directly.
  // Update NGROK_HOST or add other origins here when your tunnel changes.
  allowedDevOrigins: [
    "hurt-sash-daylight.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.ngrok.io",
    ...(process.env.NGROK_HOST ? [process.env.NGROK_HOST] : []),
  ],
};

export default nextConfig;
