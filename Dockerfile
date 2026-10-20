FROM node:20-bookworm-slim
# Chromium from Debian works on both x86 and Arm servers (Puppeteer's own download does not on Arm)
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=1 CHROME_PATH=/usr/bin/chromium NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
