FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV TALLY_DEPLOY_TARGET=node TALLY_BASE_PATH=/finance/ VITE_AUTH_ENABLED=false
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./
USER node
EXPOSE 3001
CMD ["node", "server/index.mjs"]
