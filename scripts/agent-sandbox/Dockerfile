FROM rust:1.95-bookworm AS launcher
WORKDIR /build
COPY Cargo.lock Cargo.toml ./
COPY src/ ./src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --locked && cp target/debug/shellspan-sandbox-probe /nono-probe

FROM node:24.22.3-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat ripgrep procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/phase1 --ignore-scripts --no-audit --no-fund --save-exact @anthropic-ai/sandbox-runtime@0.0.83 \
    && mkdir /phase1-output && chown node:node /phase1-output
WORKDIR /phase1
COPY --from=launcher /nono-probe ./nono-probe
COPY verify.mjs network-probe.mjs ./
USER node
ENTRYPOINT ["node", "verify.mjs", "./nono-probe", "/opt/phase1/node_modules/.bin/srt", "/phase1-output"]
