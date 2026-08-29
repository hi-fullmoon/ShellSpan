FROM alpine:3.22

RUN apk add --no-cache openssh \
    && adduser -D -s /bin/sh termbridge \
    && echo 'termbridge:termbridge-e2e' | chpasswd \
    && mkdir -p /home/termbridge/upload /run/sshd /var/lib/termbridge-m6 \
    && printf 'inactive\n' > /var/lib/termbridge-m6/service.state \
    && printf '0\n' > /var/lib/termbridge-m6/restart.count \
    && printf 'root-only-fixture-secret\n' > /root/termbridge-m6-root-only \
    && chmod 600 /root/termbridge-m6-root-only \
    && chown -R termbridge:termbridge /home/termbridge /var/lib/termbridge-m6

COPY sshd_config /etc/ssh/sshd_config
COPY termbridge-m6-service /usr/local/bin/termbridge-m6-service

RUN chmod 0755 /usr/local/bin/termbridge-m6-service

EXPOSE 22

CMD ["sh", "-c", "ssh-keygen -A || exit $?; (while true; do printf 'termbridge-forward-ok\\n' | nc -l -p 18080; done) & exec /usr/sbin/sshd -D -e"]
