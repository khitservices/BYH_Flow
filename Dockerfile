FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data/files && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
