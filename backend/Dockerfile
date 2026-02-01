# 1. Use a stable and lightweight Python 3.12 environment
FROM python:3.12-slim

# 2. Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Install system dependencies
# We need libpq-dev for Postgres and gcc for compiling some Python libraries
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 4. Set the working directory in the container
WORKDIR /app

# 5. Install Python dependencies 
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 6. Copy the rest of the project
COPY . .

# 7. Create a user for safe execution (not running as root)
RUN useradd -m -u 1000 django && chown -R django:django /app
USER django

# 8. Port on which the web app will run
EXPOSE 8000

# We do not define the command (CMD) here, because it is set in docker-compose.yml
# (each container runs something different)