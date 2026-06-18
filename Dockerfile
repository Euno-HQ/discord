FROM node:24-alpine AS build
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
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
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && \
    apk del .build-deps

COPY --from=build /app/build ./build
ADD index.prod.js ./

COPY scripts ./scripts
COPY kysely.config.ts ./
COPY migrations ./migrations

CMD ["npm", "run", "start"]
