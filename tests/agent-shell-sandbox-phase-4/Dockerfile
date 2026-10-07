FROM shellspan-ssh-e2e:local

# Dependencies are baked into this disposable project-owned SSH fixture.
# Production capability probing never installs them on a target.
RUN apk add --no-cache bubblewrap coreutils
COPY transport_server.py /opt/phase4_transport_server.py
