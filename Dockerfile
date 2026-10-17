FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
ENV DATA_DIR=/data
VOLUME ["/data"]
CMD ["node", "src/index.mjs"]
