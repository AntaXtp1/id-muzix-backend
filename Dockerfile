FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Expose port
EXPOSE 3001

# Start
CMD ["node", "src/index.js"]
