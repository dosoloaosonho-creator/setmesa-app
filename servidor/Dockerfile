FROM node:20-alpine

# better-sqlite3 compila código nativo; estas ferramentas só existem na build.
RUN apk add --no-cache --virtual .build python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && apk del .build

COPY src ./src

ENV PORTA=8080
ENV BANCO=/dados/setmesa-licencas.db
VOLUME ["/dados"]
EXPOSE 8080

CMD ["node", "src/servidor.js"]
