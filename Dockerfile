FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

ENV NODE_ENV=production


COPY . .

RUN npm run build

ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/index.js"]
