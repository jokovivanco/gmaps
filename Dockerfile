FROM node:20.16.0

WORKDIR /app

COPY package*.json ./

RUN npm install
RUN npx playwright install
RUN npx playwright install-deps

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
