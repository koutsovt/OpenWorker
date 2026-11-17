# NOT YET BUILT OR RUN: Docker was unavailable where this was written. The test step
# below is what qualifies the image: it runs the OpenWorker runtime inside the container.
# Debian-based on purpose; the OpenWorker runtime does not support Alpine (musl).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test
# State (audit ledger, runs, evidence, reports) lives on a mounted volume. One replica only.
ENV WORKFORCE_STATE_DIR=/data
VOLUME /data
# Hosted use needs API-key providers; remove the Claude (claude-code) provider from config first.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/cli/main.ts"]
CMD ["runs"]
