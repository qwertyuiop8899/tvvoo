# Multi-stage Dockerfile for VAVOO addon 
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund \
 && npm install -D @types/luxon --no-audit --no-fund
COPY . ./
RUN npm run build

# Copia lo script di prebuild e lo esegui
COPY prebuild.js ./prebuild.js
RUN node prebuild.js

# --- runtime stage ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
RUN mkdir -p dist/cache/catalog dist/cache/hints
RUN touch dist/vavoo_catalog_cache.json
RUN printf "require('/app/dist/addon.js');\n" > /start \
 && chmod 644 /start

ENV PORT=5000
EXPOSE 5000
CMD ["node", "dist/addon.js"]
