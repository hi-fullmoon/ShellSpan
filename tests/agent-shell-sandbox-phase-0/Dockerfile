FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 && rm -rf /var/lib/apt/lists/*
USER node
ENTRYPOINT ["bwrap"]
