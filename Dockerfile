FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY seed ./seed
ENV NODE_ENV=production
CMD ["npm", "run", "api"]
