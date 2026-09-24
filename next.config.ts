import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['cheerio', 'axios', '@cursor/sdk'],
};

export default nextConfig;
