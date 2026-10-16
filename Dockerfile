FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.25.0 && pnpm install --prod --frozen-lockfile
COPY server.mjs index.html ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
