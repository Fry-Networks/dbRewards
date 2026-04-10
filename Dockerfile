FROM 1password/op:2@sha256:57d7d6a2bb2b74b2cf8111f6afb2973c74772198f82ea30359a53faae9fff5b1 AS op

FROM node:20.18.0-alpine

# Set working directory
WORKDIR /app

# Install system dependencies (runtime only)
RUN apk add --no-cache \
    ca-certificates \
    dumb-init \
    wget

# Copy official 1Password CLI binary from the upstream image
COPY --from=op /usr/local/bin/op /usr/local/bin/op

# Copy package files
COPY package*.json ./

# Install dependencies with optimizations
RUN npm ci --only=production --no-cache --prefer-offline \
    && npm cache clean --force \
    && rm -rf /tmp/* /var/cache/apk/*

# Copy built application (assumes you've run `npm run build`)
COPY dist/ ./dist/

# Copy entrypoint wrapper for runtime secrets injection
COPY op-entrypoint.sh /usr/local/bin/op-entrypoint.sh
RUN chmod 755 /usr/local/bin/op-entrypoint.sh

# Create necessary directories
RUN mkdir -p logs && chmod 755 logs

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S dbrewards -u 1001 -G nodejs

# Change ownership of app directory
RUN chown -R dbrewards:nodejs /app

# Switch to non-root user
USER dbrewards

# Health check — verify the node process is running (batch job, no HTTP server)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD pgrep -f "node dist/" || exit 1

# Start the application with dumb-init + op runtime injection
ENTRYPOINT ["dumb-init", "/usr/local/bin/op-entrypoint.sh"]
CMD ["node", "dist/main.js"]
