FROM alpine:3.22

RUN apk add --no-cache openssh \
    && adduser -D -s /bin/sh shellspan \
    && echo 'shellspan:shellspan-e2e' | chpasswd \
    && mkdir -p /home/shellspan/upload /run/sshd /var/lib/shellspan-m6 \
    && printf 'inactive\n' > /var/lib/shellspan-m6/service.state \
    && printf '0\n' > /var/lib/shellspan-m6/restart.count \
    && printf 'root-only-fixture-secret\n' > /root/shellspan-m6-root-only \
    && chmod 600 /root/shellspan-m6-root-only \
    && chown -R shellspan:shellspan /home/shellspan /var/lib/shellspan-m6

COPY sshd_config /etc/ssh/sshd_config
COPY shellspan-m6-service /usr/local/bin/shellspan-m6-service

RUN chmod 0755 /usr/local/bin/shellspan-m6-service

EXPOSE 22

CMD ["sh", "-c", "ssh-keygen -A || exit $?; (while true; do printf 'shellspan-forward-ok\\n' | nc -l -p 18080; done) & exec /usr/sbin/sshd -D -e"]
