FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /app/data
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
