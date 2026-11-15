FROM node:22-bookworm-slim

WORKDIR /app

# No npm dependencies. Node 22 supplies fetch, WebSocket, and SQLite.
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/app/data/buywire.sqlite
ENV LOG_PATH=/app/data/buywire.log

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
