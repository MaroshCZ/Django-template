# 1. Použijeme stabilní a lehké prostředí Pythonu 3.12
FROM python:3.12-slim

# 2. Nastavíme proměnné, aby Python nebyl "ukecaný" a hned vypisoval logy
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Instalace systémových závislostí
# Potřebujeme libpq-dev pro Postgres a gcc pro kompilaci některých Python knihoven
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 4. Nastavení pracovního adresáře v kontejneru
WORKDIR /app

# 5. Instalace Python závislostí (děláme to před kopírováním kódu kvůli cache)
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 6. Kopírování zbytku projektu
COPY . .

# 7. Vytvoření uživatele pro bezpečné běhání (ne jako root)
RUN useradd -m -u 1000 django && chown -R django:django /app
USER django

# 8. Port, na kterém poběží web
EXPOSE 8000

# Příkaz (CMD) tady nedáváme, protože ho definujeme v docker-compose.yml 
# (každý kontejner spouští něco jiného)