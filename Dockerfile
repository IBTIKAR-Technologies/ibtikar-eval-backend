FROM node:20-alpine AS builder
WORKDIR /app
ENV NODE_ENV=development

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=false

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN yarn build

FROM node:20-alpine AS prod-deps
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p logs && chown -R node:node /app
USER node

EXPOSE 4000
CMD ["node", "dist/src/server.js"]
