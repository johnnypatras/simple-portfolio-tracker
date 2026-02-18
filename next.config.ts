import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["192.168.8.150"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
