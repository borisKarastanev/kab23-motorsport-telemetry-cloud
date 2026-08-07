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

# `dist/migrations` comes along deliberately: the one-shot `migrate` service in
# docker-compose.prod.yaml runs from this same image, so the compiled DataSource
# and migrations have to be in it. Nothing here needs ts-node.
COPY --from=development /usr/src/app/dist ./dist

# `node` (uid 1000) exists in the base image. Root is the default and there is no
# reason for it: this process opens a socket and talks to Postgres, and a
# container breakout is a great deal cheaper from uid 0.
USER node

CMD ["node", "dist/apps/api/main"]
