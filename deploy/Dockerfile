FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/neo-thc
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund
COPY dist/server ./dist/server
USER node
ENV NEO_SERVICE_CONFIG=/run/neo/service.json
CMD ["node", "dist/server/server/service.js"]
