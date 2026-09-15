FROM alpine:3.22

RUN apk add --no-cache bash zsh openssh python3 \
    && adduser -D -s /bin/bash gate \
    && echo 'gate:gate-fixture-only' | chpasswd \
    && mkdir -p /run/sshd /home/gate/agent-direct-shell-gate \
    && chown -R gate:gate /home/gate

COPY sshd_config /etc/ssh/sshd_config
COPY attack.bash attack.zsh raw_tui.py /home/gate/agent-direct-shell-gate/
RUN chown -R gate:gate /home/gate/agent-direct-shell-gate

CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
