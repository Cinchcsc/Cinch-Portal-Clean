/** @type {import('next').NextConfig} */
const nextConfig = {
  // soap is a server-only Node package; keep it out of the client bundle (Next 14 key)
  experimental: { serverComponentsExternalPackages: ['soap'] },
};
export default nextConfig;
