# Cloud Run container for empx-mcp-gateway
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run sets PORT; default 8080 matches config.ts
EXPOSE 8080
CMD ["node", "dist/index.js"]
