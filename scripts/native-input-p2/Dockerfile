FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server locales libncurses-dev python3 clang \
    && rm -rf /var/lib/apt/lists/* && localedef -i en_US -f UTF-8 en_US.UTF-8 && mkdir -p /run/sshd \
    && useradd -m -s /bin/bash native41 && useradd -m -s /bin/bash native44 && useradd -m -s /bin/bash native53 \
    && useradd -m -s /bin/bash nativeRaw
WORKDIR /work
