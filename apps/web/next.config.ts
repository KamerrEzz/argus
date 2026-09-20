import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // NOTE: the `eslint` option was removed in Next 16 (config validation and
  // typings both reject it). Lint runs via `eslint .` from the repo root.
  typescript: {
    ignoreBuildErrors: false,
  },
  // Emit the minimal server bundle the Docker image copies.
  output: 'standalone',
  experimental: {
    optimizePackageImports: [],
  },
};

export default nextConfig;
