# EC2 Production Deployment

This project is prepared to run on an EC2 instance behind Nginx with:

- API at `https://api.yengsang.com`
- Admin UI at `https://cmsportal.yengsang.com/admin`

## 1. DNS

Create these DNS records so both subdomains point to your EC2 public IP:

- `api.yengsang.com`
- `cmsportal.yengsang.com`

## 2. Server packages

On Ubuntu/Debian EC2:

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 3. App directory

```bash
sudo mkdir -p /var/www/contact
sudo chown -R $USER:$USER /var/www/contact
cd /var/www/contact
git clone https://github.com/yengsang/contact.git .
```

## 4. PostgreSQL

Create the database and user if needed:

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE contact;
CREATE USER contact_app WITH ENCRYPTED PASSWORD 'change-this-password';
GRANT ALL PRIVILEGES ON DATABASE contact TO contact_app;
\q
```

## 5. Environment

Create `.env` in `/var/www/contact`:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=1337
PUBLIC_URL=https://api.yengsang.com
ADMIN_URL=https://cmsportal.yengsang.com/admin
SERVE_ADMIN_PANEL=true
CORS_ORIGIN="https://cmsportal.yengsang.com,https://api.yengsang.com"
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=contact
DATABASE_USERNAME=contact_app
DATABASE_PASSWORD=change-this-password
DATABASE_SCHEMA=public
DATABASE_SSL=false
APP_KEYS="replace-me-1,replace-me-2,replace-me-3,replace-me-4"
API_TOKEN_SALT=replace-me
ADMIN_JWT_SECRET=replace-me
TRANSFER_TOKEN_SALT=replace-me
JWT_SECRET=replace-me
```

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 6. Install and build

```bash
cd /var/www/contact
npm ci
NODE_ENV=production npm run build
```

## 7. PM2

The PM2 config file is [deploy/pm2/ecosystem.config.js](/c:/Personal/Codex/Contact/deploy/pm2/ecosystem.config.js).

Start Strapi:

```bash
cd /var/www/contact
pm2 start deploy/pm2/ecosystem.config.js
pm2 save
pm2 startup
```

## 8. Nginx

Copy the sample config from [deploy/nginx/strapi.conf](/c:/Personal/Codex/Contact/deploy/nginx/strapi.conf) to `/etc/nginx/sites-available/contact`.

One small addition is required near the top of the `http` context in `/etc/nginx/nginx.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

Then enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/contact /etc/nginx/sites-enabled/contact
sudo nginx -t
sudo systemctl reload nginx
```

## 9. TLS certificates

Install Certbot and issue certificates:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yengsang.com -d cmsportal.yengsang.com
```

## 10. Firewall / security groups

Allow:

- `22` for SSH
- `80` for HTTP
- `443` for HTTPS

Keep port `1337` private to the instance. Nginx should be the only public entrypoint.

## 11. Verification

After deployment:

- `https://api.yengsang.com/api/app-users`
- `https://cmsportal.yengsang.com/admin`

The API and admin UI are served by the same Strapi process, but Nginx separates the public API hostname from the admin hostname.
