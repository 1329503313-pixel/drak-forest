#!/usr/bin/env bash
# 在 Linux 服务器上以 Docker 部署 MySQL 8.4 + 持久卷（示例路径 /opt/mysql-docker）
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/mysql-docker}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

ROOT_PW=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 22)
APP_PW=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 22)

cat > docker-compose.yml << 'YAML'
services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-dark_forest}
      MYSQL_USER: ${MYSQL_USER:-darkforest}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    ports:
      - "${MYSQL_PUBLISH_PORT:-3306}:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 5s
      timeout: 5s
      retries: 35
      start_period: 60s

volumes:
  mysql_data:
YAML

{
  echo "MYSQL_ROOT_PASSWORD=$ROOT_PW"
  echo "MYSQL_DATABASE=dark_forest"
  echo "MYSQL_USER=darkforest"
  echo "MYSQL_PASSWORD=$APP_PW"
} > .env
chmod 600 .env

docker compose up -d

echo ""
echo "=== MySQL 容器已启动（数据卷 mysql_data，持久化）==="
echo "=== 请妥善保存以下口令（仅此输出一次）： ==="
echo "MYSQL_ROOT_PASSWORD=$ROOT_PW"
echo "MYSQL_PASSWORD=$APP_PW"
echo "MYSQL_USER=darkforest"
echo "MYSQL_DATABASE=dark_forest"
echo "=== 配置路径: $INSTALL_DIR/.env ==="
docker compose ps
