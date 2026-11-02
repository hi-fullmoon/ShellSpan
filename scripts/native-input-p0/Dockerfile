FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
ARG FIXTURE_UID=1000
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server locales \
    libncurses-dev python3 clang && rm -rf /var/lib/apt/lists/* \
    && localedef -i en_US -f UTF-8 en_US.UTF-8 \
    && useradd -m -u "$FIXTURE_UID" -s /bin/bash p0 && passwd -d p0 \
    && mkdir -p /run/sshd /home/p0/.ssh && chmod 700 /home/p0/.ssh
EXPOSE 22229
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/work/.artifacts/tests/native-input-p0/ssh/sshd_config"]
