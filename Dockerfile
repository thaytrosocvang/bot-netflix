FROM node:20

# Cài python3 + pip + venv + Chromium cho Puppeteer
RUN apt-get update && \
    apt-get install -y \
      python3 python3-pip python3-venv \
      chromium \
      fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
      libatk1.0-0 libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
      libxrandr2 xdg-utils libxss1 libxtst6 lsb-release wget \
      --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Báo cho Puppeteer biết đường dẫn Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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