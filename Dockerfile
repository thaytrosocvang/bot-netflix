FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN python3 -m venv venv && \
    ./venv/bin/pip install --upgrade pip --quiet && \
    ./venv/bin/pip install -r requirements.txt --quiet

EXPOSE 3000
CMD ["node", "index.js"]