FROM node:24.22.2-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 AS native_node
FROM shellspan-native-input-p2:local
COPY --from=native_node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends zsh \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /usr/bin/zsh nativeZle
