FROM node:20

# Cài python3 + pip + venv tools
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài Node dependencies
COPY package*.json ./
RUN npm install

# Copy toàn bộ source
COPY . .

# Tạo virtual environment và cài Python dependencies
RUN python3 -m venv venv && \
    ./venv/bin/pip install --upgrade pip && \
    ./venv/bin/pip install -r requirements.txt

EXPOSE 3000

CMD ["node", "index.js"]