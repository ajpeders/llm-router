FROM node:24-alpine
WORKDIR /app
COPY router.js /app/router.js
COPY src /app/src
EXPOSE 8080
CMD ["node", "/app/router.js"]
