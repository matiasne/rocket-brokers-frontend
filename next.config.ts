import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Used by docker/web.Dockerfile: `next build` emits a self-contained server in .next/standalone.
  output: 'standalone',
};

export default nextConfig;
