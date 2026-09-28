FROM debian:bookworm-slim

RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::Retries=2 update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::Retries=2 \
       systemd systemd-sysv dbus python3 ca-certificates openssh-server \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
