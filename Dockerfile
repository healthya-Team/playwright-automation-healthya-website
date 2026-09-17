# Matches the resolved @playwright/test version in pnpm-lock.yaml (1.60.0) so the
# preinstalled browsers in this image line up with the npm package — bump both together.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 5001

CMD ["node", "dashboard.js"]
