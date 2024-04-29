FROM node:21

RUN apt-get update -y && apt-get install -y ffmpeg

WORKDIR /app
COPY . /app/
RUN npm install
RUN npm run build

ENTRYPOINT [ "node", "build/index.js" ]
