FROM public.ecr.aws/docker/library/node:22-alpine
RUN apk add --no-cache openssh \
    && adduser -D shellspan \
    && mkdir -p /run/sshd /home/shellspan/upload \
    && chown shellspan:shellspan /home/shellspan/upload
COPY sshd_config /etc/ssh/sshd_config
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
