FROM node:24.22.1-alpine AS build
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3).
# Unpinned on purpose: Alpine drops superseded package versions from its repos,
# so exact pins break the build; the base image tag already pins the release.
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm install

COPY vite.config.ts kysely.config.ts tsconfig.json .eslint* .prettierignore ./
COPY app ./app
# Legal content is imported via `?raw` and inlined into the build, so the
# markdown only needs to exist in the build stage — not the runtime image.
COPY PRIVACY_POLICY.md TERMS_OF_SERVICE.md ./

RUN npm run build

# Build the production image with minimal footprint
FROM node:24.22.1-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Unpinned build deps, removed in the same layer; see the build stage.
# hadolint ignore=DL3018
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && \
    apk del .build-deps

COPY --from=build /app/build ./build
COPY index.prod.js ./

COPY scripts ./scripts
COPY kysely.config.ts ./
COPY migrations ./migrations

# Run migrations, then exec node so it becomes PID 1 and receives the pod's
# SIGTERM directly. Through `npm run start` (npm -> sh -> npm -> sh -> node)
# the signal stops at the shell running the `;` sequence, and graceful
# shutdown never runs.
CMD ["sh", "-c", "npm run start:migrate; exec node ./index.prod.js"]
