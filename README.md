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
