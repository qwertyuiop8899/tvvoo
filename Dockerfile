# Multi-stage Dockerfile for VAVOO addon

# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
# Install deps (include dev for TypeScript)
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund
# Copy sources and build
COPY . ./
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Install only prod deps
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
# Copy built files only
COPY --from=build /app/dist ./dist
# Ensure cache file path exists even if empty
RUN touch dist/vavoo_catalog_cache.json
# Some PaaS force `node /start` as the entrypoint; provide a real file requiring our entry
RUN printf "require('/app/dist/addon.js');\n" > /start \
 && chmod 644 /start
# Health and port
ENV PORT=3000
CMD ["node", "dist/addon.js"]
