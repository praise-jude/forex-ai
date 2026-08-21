import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Drops the X-Powered-By response header on every request -- free, no functional effect.
  poweredByHeader: false,
  // Strips console.log/warn/debug/info from production client bundles (console.error is
  // kept, so a genuine runtime error is still visible) -- pure size/noise reduction, no
  // behavior change, since these were only ever printing to a browser console.
  compiler: {
    removeConsole: { exclude: ["error"] },
  },
};

export default nextConfig;
