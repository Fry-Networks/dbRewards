FROM node:20.18.0-alpine

# Set working directory
WORKDIR /app

# Install system dependencies and 1Password CLI
RUN apk add --no-cache \
    curl \
    wget \
    unzip \
    dumb-init \
    && wget -O /tmp/op.zip https://cache.agilebits.com/dist/1P/op2/pkg/v2.32.0/op_linux_amd64_v2.32.0.zip \
    && unzip /tmp/op.zip -d /tmp/op \
    && mv /tmp/op/op /usr/local/bin/op \
    && chmod +x /usr/local/bin/op \
    && rm -rf /tmp/op /tmp/op.zip

# Copy package files
COPY package*.json ./

# Install dependencies with optimizations
RUN npm ci --only=production --no-cache --prefer-offline \
    && npm cache clean --force \
    && rm -rf /tmp/* /var/cache/apk/*

# Copy built application (assumes you've run `npm run build`)
COPY dist/ ./dist/

# Create necessary directories
RUN mkdir -p logs && chmod 755 logs

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S dbrewards -u 1001 -G nodejs

# Change ownership of app directory
RUN chown -R dbrewards:nodejs /app

# Switch to non-root user
USER dbrewards

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${DASHBOARD_PORT:-30033}/health || exit 1

# Expose port
EXPOSE ${DASHBOARD_PORT:-30033}

# Start the application with dumb-init for proper signal handling
CMD ["dumb-init", "op", "run", "--", "node", "dist/main.js"]
