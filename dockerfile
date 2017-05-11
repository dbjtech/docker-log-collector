FROM node:alpine

ADD ./package.json /src/app/package.json
WORKDIR /src/app

RUN npm i --production && npm cache clean

ADD . .

CMD node .
