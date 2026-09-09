FROM node:22-alpine3.23

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
