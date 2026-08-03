FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# postgresql-client — для эндпоинта бэкапа БД (pg_dump, см. system/backup.service.ts).
# docker-cli/docker-compose-plugin/git — для самообновления по кнопке (см.
# system/update.service.ts): backend вызывает `docker compose up -d --build` на ХОСТЕ
# через смонтированный /var/run/docker.sock (см. docker-compose.yml), поэтому здесь нужен
# сам docker CLI, а не демон.
RUN apk add --no-cache postgresql-client docker-cli docker-cli-compose git
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main.js"]
