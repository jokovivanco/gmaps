FROM oven/bun:1

WORKDIR /app

COPY package*.json ./

RUN bun install
RUN bunx playwright install
RUN bunx playwright install-deps

COPY . .

EXPOSE 3000

CMD ["bun", "server.js"]
