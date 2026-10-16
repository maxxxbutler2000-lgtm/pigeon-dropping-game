FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs index.html ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
