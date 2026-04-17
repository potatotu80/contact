# Strapi Contact Backend

This workspace contains a Strapi v4 backend configured to use PostgreSQL.

## Content Types

- `User`
  - `email` (`email`, required, unique)
  - `device_id` (`string`, required)
- `Contact`
  - `name` (`string`, required)
  - `phone` (`string`, required)
  - `email` (`email`, optional)
  - `user` (`many-to-one` relation to `User`, required)

## REST API

Strapi REST is enabled by default in [config/api.js](/c:/Personal/Codex/Contact/config/api.js).

Custom collection endpoints:

- `GET/POST /api/app-users`
- `GET/PUT/DELETE /api/app-users/:id`
- `GET/POST /api/contacts`
- `GET/PUT/DELETE /api/contacts/:id`

`app-users` is used for the route path to avoid conflicting with Strapi's built-in `users-permissions` plugin routes under `/api/users`.

## Run Locally

1. Create a PostgreSQL database, for example `contact`.

2. Copy the environment template and update the database credentials:

```bash
copy .env.example .env
```

Set these values in `.env`:

```env
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=contact
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=postgres
DATABASE_SCHEMA=public
DATABASE_SSL=false
```

3. Install dependencies if needed:

```bash
npm install
```

4. Start Strapi in development mode:

```bash
npm run develop
```

5. Open the admin panel:

```text
http://localhost:1337/admin
```

On first run, Strapi will prompt you to create the initial admin user in the browser.

## Useful Commands

```bash
npm run develop
npm run build
npm run start
```

## Production Deployment

Production deployment files for EC2 + Nginx are included in:

- [deploy/nginx/strapi.conf](/c:/Personal/Codex/Contact/deploy/nginx/strapi.conf)
- [deploy/pm2/ecosystem.config.js](/c:/Personal/Codex/Contact/deploy/pm2/ecosystem.config.js)

Recommended production URLs:

- API: `https://api.yengsang.com`
- Admin: `https://cmsportal.yengsang.com/admin`

Set these environment variables on the EC2 instance before building and starting Strapi:

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
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=change-me
DATABASE_SCHEMA=public
DATABASE_SSL=false
APP_KEYS="replace-me-1,replace-me-2,replace-me-3,replace-me-4"
API_TOKEN_SALT=replace-me
ADMIN_JWT_SECRET=replace-me
TRANSFER_TOKEN_SALT=replace-me
JWT_SECRET=replace-me
```

Build and run in production:

```bash
npm ci
NODE_ENV=production npm run build
NODE_ENV=production npm run start
```
