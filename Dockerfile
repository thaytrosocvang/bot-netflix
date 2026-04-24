FROM node:20

# Cài python + venv
RUN apt-get update && \
    apt-get install -y python3 python3-venv

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Tạo virtual environment
RUN python3 -m venv venv

# Cài pip trong venv
RUN ./venv/bin/pip install --upgrade pip

# Cài requirements trong venv
RUN ./venv/bin/pip install -r requirements.txt

EXPOSE 3000

CMD ["node", "index.js"]