FROM alpine:3.22

RUN apk add --no-cache openssh \
    && adduser -D -s /bin/sh termbridge \
    && echo 'termbridge:termbridge-e2e' | chpasswd \
    && mkdir -p /home/termbridge/upload /run/sshd \
    && chown -R termbridge:termbridge /home/termbridge

COPY sshd_config /etc/ssh/sshd_config

EXPOSE 22

CMD ["sh", "-c", "ssh-keygen -A || exit $?; (while true; do printf 'termbridge-forward-ok\\n' | nc -l -p 18080; done) & exec /usr/sbin/sshd -D -e"]
