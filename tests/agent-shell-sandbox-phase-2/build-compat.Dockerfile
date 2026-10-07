# Provisioning creates a disposable tool/cache image, not an Agent network grant.
FROM shellspan-sandbox-phase2:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client zsh pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/cargo /opt/rust /opt/app && chown -R node:node /opt/cargo /opt/rust /opt/app
USER node
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.95.0 --no-modify-path \
    && /opt/cargo/bin/rustup component add rustfmt --toolchain 1.95.0 \
    && rm /tmp/rustup-init.sh
ENV PATH=/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /opt/app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node patches ./patches
RUN pnpm install --frozen-lockfile --store-dir /opt/app/.compat-pnpm-store
COPY --chown=node:node . .
COPY --chown=node:node run_build_compat.sh /opt/run_build_compat.sh
RUN cargo fetch --locked --manifest-path src-tauri/Cargo.toml
WORKDIR /workspace
