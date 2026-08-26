# VivaVoce 实时会话服务 (TS/Node) — M1 起跑 Fargate 普通容器(无 SIP/RTP,无 EC2/EIP)
FROM node:22-slim AS build
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ARG NPM_REGISTRY
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/dist ./dist

EXPOSE 3001
RUN useradd --create-home --uid 10003 bridge
USER bridge

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
