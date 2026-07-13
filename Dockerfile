FROM node:22-alpine AS webbuild
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY --from=webbuild /build/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "src/index.js"]
