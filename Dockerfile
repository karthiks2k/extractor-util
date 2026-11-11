FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

ENV PORT=8080

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
