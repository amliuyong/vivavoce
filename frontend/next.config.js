/** @type {import('next').NextConfig} */
// Next.js 静态导出(design contract):纯客户端渲染,产物只是静态资源,传 S3 由 CloudFront 分发。
// 无 SSR 运行时;`/api/*` 由 CloudFront 行为回源私有 ALB(本前端只发相对 /api 请求)。
const nextConfig = {
  output: 'export',
  // 静态导出下默认会做图片优化(需运行时),关掉用原图。
  images: { unoptimized: true },
  // 资源用相对/根路径即可(CloudFront 根托管)。
  trailingSlash: false,
  // 严格模式帮助发现副作用问题。
  reactStrictMode: true,
};

module.exports = nextConfig;
