# Runtime image for the Node engine plus the Specmatic JVM/plugin stack.
# The compose file runs the two processes as sibling services from this image;
# keeping them separate gives each process independent lifecycle and logging.

FROM node:24-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openjdk-17-jdk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
RUN cd plugin && ./gradlew shadowJar --no-daemon
ARG SPECMATIC_VERSION=2.46.2
RUN curl --fail --location --output /tmp/specmatic.jar \
  "https://github.com/specmatic/specmatic/releases/download/${SPECMATIC_VERSION}/specmatic.jar"

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=development
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/start-specmatic.mjs /app/scripts/start-specmatic.mjs
COPY --from=build /app/plugin/build/libs/potemkin-stateful-plugin.jar /opt/potemkin/potemkin-stateful-plugin.jar
COPY --from=build /tmp/specmatic.jar /opt/potemkin/specmatic.jar

EXPOSE 3000 9000 9090
CMD ["node", "dist/src/cli/server.js"]
