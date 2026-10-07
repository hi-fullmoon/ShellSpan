FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends python3 cargo rustc \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.1.1
COPY --chown=node:node projects /opt/projects
USER node
WORKDIR /workspace
ENTRYPOINT []
