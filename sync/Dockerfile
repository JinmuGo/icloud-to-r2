FROM node:22-slim

WORKDIR /app

# sharp requires these system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libheif-dev \
    libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY sync-to-r2.js ./
COPY metadata.js ./

CMD ["node", "sync-to-r2.js"]
