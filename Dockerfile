FROM node:20-slim

# Cài python3 + pip + venv + Chromium + tất cả deps cần thiết
RUN apt-get update && \
    apt-get install -y \
      # Python
      python3 python3-pip python3-venv \
      # Chromium
      chromium \
      # Fonts
      fonts-liberation fonts-noto-color-emoji \
      # Chromium system libs
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libgcc-s1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      lsb-release \
      wget \
      ca-certificates \
      --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Puppeteer dùng Chromium hệ thống, không tự tải
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Cài Node dependencies trước (tận dụng Docker cache)
COPY package*.json ./
RUN npm install

# Copy toàn bộ source
COPY . .

# Tạo Python venv và cài dependencies
RUN python3 -m venv venv && \
    ./venv/bin/pip install --upgrade pip --quiet && \
    ./venv/bin/pip install -r requirements.txt --quiet

EXPOSE 3000

CMD ["node", "index.js"]