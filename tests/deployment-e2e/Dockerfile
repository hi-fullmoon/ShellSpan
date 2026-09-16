FROM alpine:3.22

RUN apk add --no-cache \
      bash \
      coreutils \
      curl \
      docker \
      docker-cli-compose \
      nginx \
      openssh \
      openssh-client \
      shadow \
      sudo \
      util-linux \
    && adduser -D -s /bin/sh shellspan \
    && echo 'shellspan:shellspan-deployment-e2e' | chpasswd \
    && addgroup shellspan docker \
    && mkdir -p /run/sshd /srv/shellspan-deployment /var/lib/shellspan-fixture \
    && mkdir -p /srv/shellspan-deployment/nginx-fixture \
    && printf 'pid /tmp/shellspan-nginx.pid;\nerror_log stderr;\nevents {}\nhttp { include /srv/shellspan-deployment/nginx-fixture/*.conf; }\n' > /etc/nginx/nginx.conf \
    && chown -R shellspan:shellspan /srv/shellspan-deployment /var/lib/shellspan-fixture \
    && printf 'shellspan ALL=(root) NOPASSWD: /usr/local/bin/systemctl reload nginx\n' > /etc/sudoers.d/shellspan-deployment \
    && chmod 0440 /etc/sudoers.d/shellspan-deployment

COPY sshd_config /etc/ssh/sshd_config
COPY systemctl-fixture /usr/local/bin/systemctl
COPY entrypoint.sh /usr/local/bin/shellspan-deployment-entrypoint

RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/shellspan-deployment-entrypoint

EXPOSE 22

HEALTHCHECK --interval=1s --timeout=3s --retries=60 \
  CMD docker info >/dev/null 2>&1 && ssh-keyscan -p 22 127.0.0.1 >/dev/null 2>&1

ENTRYPOINT ["/usr/local/bin/shellspan-deployment-entrypoint"]
