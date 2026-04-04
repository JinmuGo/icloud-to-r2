FROM node:22-slim

WORKDIR /app

# sharp requires these system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libheif-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY sync-to-r2.js ./

CMD ["node", "sync-to-r2.js"]
