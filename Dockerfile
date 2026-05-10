FROM node:20-alpine
WORKDIR /app
COPY router.js /app/router.js
EXPOSE 8080
CMD ["node", "/app/router.js"]
