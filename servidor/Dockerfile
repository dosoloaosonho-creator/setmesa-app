FROM node:20-alpine

# better-sqlite3 compila código nativo; estas ferramentas só existem na build.
RUN apk add --no-cache --virtual .build python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && apk del .build

COPY src ./src
# As telas do SET Mesa Nuvem sao arquivos .html de verdade e sao lidas do disco
# quando o servidor sobe. Sem esta linha o container nasce e morre na hora.
COPY publico ./publico

ENV PORTA=8080
ENV BANCO=/dados/setmesa-licencas.db
# Banco da operacao dos restaurantes: mesmo volume, arquivo separado.
ENV BANCO_NUVEM=/dados/setmesa-nuvem.db
VOLUME ["/dados"]
EXPOSE 8080

CMD ["node", "src/servidor.js"]
