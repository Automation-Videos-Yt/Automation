/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ggpht.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "**.ggpht.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "ytimg.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "**.ytimg.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
