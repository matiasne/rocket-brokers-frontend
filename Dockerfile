# The Next.js UI as a standalone server. The build context is this folder.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY next.config.ts tsconfig.json ./
COPY src src
# Next puts NEXT_PUBLIC_* values into the build, so they are needed here and not at run time.
# Both are public by design (the publishable key only works under row-level security).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
RUN pnpm exec next build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
ENV NODE_ENV=production PORT=3030 HOSTNAME=0.0.0.0
USER node
CMD ["node", "server.js"]
