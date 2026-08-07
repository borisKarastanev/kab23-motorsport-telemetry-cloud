# The Angular bundle, served by the same nginx that terminates TLS and proxies
# the API. Build context is ./frontend — this is a separate pnpm project with its
# own lockfile, so the root .dockerignore does not apply (see ./.dockerignore).
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9 --activate && \
    pnpm install --frozen-lockfile

COPY . .

# `ng build` defaults to the production configuration, which is what swaps in
# environment.prod.ts via `fileReplacements`. Without that replacement this image
# would ship an app calling http://localhost:3000 — the viewer's own machine.
RUN pnpm build

FROM nginx:alpine

COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html

# The base image ships /etc/nginx/conf.d/default.conf, which also listens on :80.
# nginx loads conf.d alphabetically and the first :80 server becomes that port's
# default, so `default.conf` — not ours — answered every request whose Host did
# not match server_name. On a public box that means anyone reaching the bare IP
# over HTTP gets nginx's welcome page instead of the redirect to HTTPS.
RUN rm /etc/nginx/conf.d/default.conf

# No site config is baked in. It is mounted from deploy/nginx/templates at run
# time, so changing a proxy rule or a TLS setting does not mean rebuilding the
# Angular bundle.
