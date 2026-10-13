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
COPY --from=build --chown=node:node /app/scripts/start-tally.mjs ./scripts/start-tally.mjs
USER node
EXPOSE 3001
CMD ["node", "scripts/start-tally.mjs"]
