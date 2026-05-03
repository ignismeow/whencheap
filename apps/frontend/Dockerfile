FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/frontend/package.json apps/frontend/package.json

RUN npm ci --workspace apps/frontend

FROM node:22-alpine AS build

WORKDIR /app

ARG NEXT_PUBLIC_API_URL=http://api:3001
ARG NEXT_PUBLIC_CHAIN_ID=11155111
ARG NEXT_PUBLIC_WALLETCONNECT_ID=
ARG NEXT_PUBLIC_SESSION_CONTRACT=
ARG NEXT_PUBLIC_MAINNET_SESSION_CONTRACT=

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
ENV NEXT_PUBLIC_WALLETCONNECT_ID=$NEXT_PUBLIC_WALLETCONNECT_ID
ENV NEXT_PUBLIC_SESSION_CONTRACT=$NEXT_PUBLIC_SESSION_CONTRACT
ENV NEXT_PUBLIC_MAINNET_SESSION_CONTRACT=$NEXT_PUBLIC_MAINNET_SESSION_CONTRACT

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/frontend apps/frontend

RUN npm run build --workspace apps/frontend

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/frontend/package.json ./apps/frontend/package.json
COPY --from=build /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=build /app/apps/frontend/public ./apps/frontend/public

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "apps/frontend", "--", "-H", "0.0.0.0"]
