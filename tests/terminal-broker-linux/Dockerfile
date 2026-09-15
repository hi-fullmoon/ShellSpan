FROM rust:1.90-bookworm

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        libayatana-appindicator3-dev \
        libdbus-1-dev \
        libgtk-3-dev \
        librsvg2-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libxdo-dev \
        patchelf \
        perl \
        pkg-config \
        zsh \
    && rm -rf /var/lib/apt/lists/*

RUN rustup toolchain install 1.95.0 --component rustfmt

RUN useradd --create-home --uid 1000 shellspan \
    && mkdir -p /cargo-target /linux-workspace \
    && chown -R shellspan:shellspan /cargo-target /linux-workspace

ENV CARGO_HOME=/home/shellspan/.cargo
ENV HOME=/home/shellspan

USER shellspan
WORKDIR /workspace

ENTRYPOINT ["/bin/bash", "/workspace/tests/terminal-broker-linux/run.sh"]
