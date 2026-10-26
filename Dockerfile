# The Playwright version must match package.json: the image ships the matching browsers.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# ffmpeg encodes the loops; the emoji font keeps emoji from rendering as boxes. Fonts are part
# of the pinned rendering, so add them here, not in the host.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-color-emoji tar \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/visual-kit
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY schema ./schema
COPY host ./host
RUN chmod +x host/run.sh bin/visual-kit.mjs

ENTRYPOINT ["node", "/opt/visual-kit/bin/visual-kit.mjs"]
