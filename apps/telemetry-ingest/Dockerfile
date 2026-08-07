FROM node:24-alpine AS development

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./
# corepack pins pnpm to the version the lockfile was written by; `npm install -g
# pnpm` would silently float to whatever is latest at build time.
RUN corepack enable && corepack prepare pnpm@9 --activate && \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

FROM node:24-alpine AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9 --activate && \
    pnpm install --frozen-lockfile --prod

COPY --from=development /usr/src/app/dist ./dist

# See apps/api/Dockerfile. This process holds the broker subscription for every
# car, so it is the one that first touches an untrusted payload.
USER node

CMD ["node", "dist/apps/telemetry-ingest/main"]
