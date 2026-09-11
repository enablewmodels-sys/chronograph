# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM rust:1.93-bookworm AS rust
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock README.md ./
COPY crates/ ./crates/
COPY examples/ ./examples/
RUN cargo build --locked --release -p chronograph-server --bins
COPY scripts/release/inventory.py ./scripts/release/inventory.py
COPY third_party/ ./third_party/
COPY --from=ui /build/ui/package-lock.json ./ui/package-lock.json
COPY --from=ui /build/ui/node_modules/ ./ui/node_modules/
RUN target=$(rustc -vV | sed -n 's/^host: //p') && python3 scripts/release/inventory.py --target "$target" --output /build/notices

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 chronograph \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin chronograph \
    && mkdir -p /app/ui /app/docs /data /config \
    && chown 10001:10001 /data /config && chmod 0700 /data /config
COPY --from=rust /build/target/release/chronograph-server /build/target/release/chronograph-mcp /usr/local/bin/
COPY --from=ui /build/ui/dist/ /app/ui/
COPY docs/*.md docs/*.svg /app/docs/
COPY docs/connectors/ /app/docs/connectors/
COPY LICENSE NOTICE /app/
COPY --from=rust /build/notices/ /app/notices/
WORKDIR /app
ENV CHRONOGRAPH_BIND=0.0.0.0:8080 CHRONOGRAPH_DATA=/data CHRONOGRAPH_AUTH=/config/auth.json CHRONOGRAPH_UI=/app/ui CHRONOGRAPH_DOCS=/app/docs
USER 10001:10001
EXPOSE 8080
VOLUME ["/data", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD origin="${CHRONOGRAPH_ORIGIN:-http://127.0.0.1:8080}"; curl --fail --silent --max-time 4 -H "Host: ${origin#*://}" http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["chronograph-server"]
CMD ["serve"]
