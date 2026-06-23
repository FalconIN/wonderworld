#!/bin/bash
# Wonder World — one-time server setup
# Run as: bash setup.sh
# Requires sudo (will prompt for password)

set -e

echo "==> Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> Installing Nginx, PostgreSQL, Certbot..."
sudo apt-get install -y nginx postgresql postgresql-contrib certbot python3-certbot-nginx

echo "==> Installing PM2 globally..."
sudo npm install -g pm2

echo "==> Setting up PostgreSQL database..."
sudo -u postgres psql <<'SQL'
CREATE USER wonderworld WITH PASSWORD 'CHANGE_ME_NOW';
CREATE DATABASE wonderworld OWNER wonderworld;
GRANT ALL PRIVILEGES ON DATABASE wonderworld TO wonderworld;
SQL

echo "==> Running schema..."
PGPASSWORD=CHANGE_ME_NOW psql -U wonderworld -d wonderworld -f /home/claudeuser/wonderworld/server/schema.sql

echo "==> Installing Node.js server dependencies..."
cd /home/claudeuser/wonderworld/server && npm install

echo "==> Copying nginx config..."
sudo cp /home/claudeuser/wonderworld/nginx.conf /etc/nginx/sites-available/wonderworld
sudo ln -sf /etc/nginx/sites-available/wonderworld /etc/nginx/sites-enabled/wonderworld
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "==> NEXT STEPS:"
echo "1. Copy .env.example to .env and fill in all values:"
echo "   cp /home/claudeuser/wonderworld/.env.example /home/claudeuser/wonderworld/.env"
echo "   nano /home/claudeuser/wonderworld/.env"
echo ""
echo "2. Inject Firebase config into HTML:"
echo "   node /home/claudeuser/wonderworld/scripts/inject-env.js"
echo ""
echo "3. Start the server with PM2:"
echo "   cd /home/claudeuser/wonderworld && pm2 start ecosystem.config.js"
echo "   pm2 save && pm2 startup"
echo ""
echo "4. (Optional) Get SSL certificate:"
echo "   sudo certbot --nginx -d wonderworldwestgate.co.nz -d www.wonderworldwestgate.co.nz"
echo ""
echo "Done!"
