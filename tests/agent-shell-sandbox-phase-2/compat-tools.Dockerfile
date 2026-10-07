# Extend the recorded compatibility image without rebuilding its source/cache.
FROM shellspan-build-compat:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client zsh \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node .agents/skills/shadcn/SKILL.md /opt/app/.agents/skills/shadcn/SKILL.md
USER node
