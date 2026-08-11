FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/agent/package.json apps/agent/tsconfig.json ./apps/agent/
RUN pnpm install --frozen-lockfile=false
COPY packages/protocol ./packages/protocol
COPY apps/agent ./apps/agent
RUN pnpm --filter @micopanel/agent build

FROM node:22-alpine
RUN apk add --no-cache tar
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent/dist ./apps/agent/dist
COPY --from=build /app/apps/agent/package.json ./apps/agent/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
CMD ["node", "apps/agent/dist/index.js"]

