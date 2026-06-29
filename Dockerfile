FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip git build-base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev

COPY server ./server
COPY planos.jpg ./planos.jpg

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/bot-standalone.mjs"]
