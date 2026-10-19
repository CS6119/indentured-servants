FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY app ./app
COPY tests-ts ./tests-ts
RUN npm run validate && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright \
    && mkdir /app/data && chown node:node /app/data
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 CMD ["node", "dist/cli.js", "health"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["bot"]
