# Deployment Guide

This guide explains how to deploy Voltex to your VPS with proper environment configuration.

## Environment Variables

### Public Variables (committed to repo)

- `VITE_PUBLIC_BUILDER_KEY` - Builder.io API key
- `PING_MESSAGE` - Demo ping message
- `R2_ENDPOINT_URL` - Cloudflare R2 endpoint (public, non-sensitive)

### Secret Variables (NOT committed - set on deployment)

- `R2_ACCESS_KEY_ID` - Cloudflare R2 access key
- `R2_SECRET_ACCESS_KEY` - Cloudflare R2 secret key

## Setup on VPS

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd voltex
pnpm install
```

### 2. Set environment variables

You have two options:

#### Option A: Create a `.env.local` file (for development)

```bash
cat > .env.local << EOF
R2_ACCESS_KEY_ID=your_access_key_id_here
R2_SECRET_ACCESS_KEY=your_secret_access_key_here
EOF
```

#### Option B: Set as system environment variables (for production)

```bash
export R2_ACCESS_KEY_ID=your_access_key_id_here
export R2_SECRET_ACCESS_KEY=your_secret_access_key_here
```

### 3. Build the application

```bash
pnpm build
```

### 4. Start the server

```bash
pnpm start
```

The app will be available at `http://localhost:3000` (or your configured port).

## Docker Deployment

If deploying with Docker, set environment variables when running the container:

```bash
docker run -e R2_ACCESS_KEY_ID=xxx -e R2_SECRET_ACCESS_KEY=xxx your-image:latest
```

Or use a `.env` file:

```bash
docker run --env-file .env your-image:latest
```

## Getting Cloudflare R2 Credentials

1. Go to your Cloudflare dashboard
2. Navigate to R2 storage
3. Create an API token or use existing ones
4. Keep `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` secure - treat them like passwords

## Security Notes

- ⚠️ **Never commit** `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` to git
- Use `.env.local` or system environment variables for secrets
- `.env.local` is in `.gitignore` for your protection
- Rotate your R2 credentials periodically
