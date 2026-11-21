FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package.json *.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /poster-data && chown node:node /poster-data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
