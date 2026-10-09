# Sri Ram Jewellery

> **Note:** much of this README below the "Before going live" section describes
> an older Next.js/Postgres version and is out of date. The app is React + Vite
> with an Express/MongoDB API; see `ARCHITECTURE.md`.

## Before going live: email sign-in

Customers sign in with their **email address**: they type it, receive a
6-digit code by email, and type the code. There are no customer passwords.
Administrators still sign in with email + password at `/admin-login`.

Nothing below is optional for production — without it **nobody can sign in**.

### 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | A Resend API key with **sending** access | From resend.com → API Keys |
| `EMAIL_FROM` | e.g. `Sri Ram Jewellery <signin@mail.sriramjewellery.in>` | Must be on the domain you verify in step 2. **Never** a gmail.com (or other webmail) address — those are refused as misconfiguration. |
| `EMAIL_REPLY_TO` | optional, e.g. `orders@sriramjewellery.in` | Where customer replies go |
| `EMAIL_PROVIDER` | optional, default `resend` | Only `resend` is implemented |
| `JWT_SECRET` | a long random string (`openssl rand -base64 32`) | Already required |
| `MONGODB_URI`, `CRON_SECRET`, `RAZORPAY_*`, `PUBLIC_SITE_URL`, `VITE_PUBLIC_SITE_URL` | as before | See `.env.example` |

**Must NOT be set in production:** `ALLOW_TEST_OTP`, `TEST_OTP_EMAILS`.
(The test code is refused in production anyway, and works only for addresses
listed in `TEST_OTP_EMAILS` — but keep them out of production entirely.)

**Preview deployments run as production** (`NODE_ENV=production`), so they need
the same email variables. The console fallback below never runs on a preview.

### What happens when email is not configured

The server still starts and product pages keep working (same as a missing
`JWT_SECRET`). It logs, at startup:

```
FATAL: email is not configured — … Sign-in codes cannot be sent: /api/auth/otp/request will return 503 until this is fixed.
```

and every code request returns **503** ("Sign-in codes can't be sent right
now"). Locally, with `NODE_ENV=development` and no `RESEND_API_KEY`, codes are
printed to the API console instead of emailed, so the flow can be tried without
an account.

Check the setup end to end with:

```
node server/scripts/testEmail.js you@example.com
```

### Resend's free tier: 100 emails a day

Every sign-in attempt sends one email. On Resend's free plan the cap is
**100 emails per day** (and 3,000 a month). When the cap is hit, Resend refuses
the send and **nobody can sign in until it resets** — customers already signed
in are unaffected. It is never silent:

- the customer sees "We couldn't send your sign-in code just now. Please try
  again in a few minutes." (HTTP 503)
- the server logs, for every refused send:

  ```
  🚨 EMAIL SEND FAILED — sign-in-code to <address> via Resend: <Resend's reason, e.g. daily_quota_exceeded>. If this is a quota error, nobody can sign in until the quota resets or the plan is raised.
  ```

Set up a log alert on `EMAIL SEND FAILED`, and move to a paid Resend plan
before launch traffic can approach 100 sign-ins a day.

### 2. DNS records for the sending domain

In Resend → Domains → **Add domain**. A sub-domain such as
`mail.sriramjewellery.in` is recommended, so sign-in mail never affects the
shop's main mailboxes. Resend then shows the exact records to add at your DNS
host. **Copy the names and values from the Resend dashboard** — they depend on
your account and region; the shapes are:

| Purpose | Type | Name (host) | Value |
|---|---|---|---|
| SPF (bounce domain) | `MX` | `send.mail` | `feedback-smtp.<region>.amazonses.com`, priority `10` |
| SPF | `TXT` | `send.mail` | `v=spf1 include:amazonses.com ~all` |
| DKIM | `TXT` | `resend._domainkey.mail` | the public key Resend gives you (`p=MIGf…`) |
| DMARC | `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@sriramjewellery.in` |

- The SPF records sit on the `send.` sub-domain Resend uses for bounces, so
  they do not clash with any SPF record you already have on the root domain.
  Never publish a second SPF record on the same name; merge instead.
- Start DMARC at `p=none`, read the reports for a couple of weeks, then move to
  `p=quarantine`.
- Wait until Resend shows the domain as **Verified** before setting
  `EMAIL_FROM` to an address on it.

---

## Older notes (out of date)

A modern, high-performance e-commerce application built with Next.js 16, TypeScript, Tailwind CSS, shadcn/ui, and Aceternity UI components.

## 📦 Previous Version

The legacy static version of this application is available at:
- **Live URL**: [https://jewellery-ecom-static.netlify.app/index.html](https://jewellery-ecom-static.netlify.app/index.html)
- **GitHub Branch**: `oldmasterbranch` - Contains the previous static HTML/CSS/JS implementation

The current repository (Next.js version) is on the `master` branch.

## Features

- 🛍️ **Product Catalog** - Browse and filter products by category, price, and more
- 🛒 **Shopping Cart** - Add, remove, and manage items in your cart
- ❤️ **Wishlist** - Save your favorite products for later
- 👤 **User Accounts** - Create an account and manage your profile
- 💳 **Checkout** - Secure checkout process with multiple payment options
- 📱 **Responsive Design** - Fully responsive design that works on all devices
- 🎨 **Modern UI** - Beautiful, modern interface with smooth animations
- ⚡ **Performance** - Optimized for speed and SEO

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: shadcn/ui
- **Animations**: Framer Motion
- **State Management**: Zustand
- **Icons**: Lucide React

## DevOps Course Notes (Our Implementation)

### Branching workflow
- `master` = stable branch (release/deploy)
- `dev` = integration branch
- Feature branches: `feature/<name>` → Pull Request into `dev`

### Local run (Docker Compose)
```bash
docker compose -f docker-compose.dev.yml up --build


## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn, OR
- Docker and Docker Compose

### Option 1: Running with Docker (Recommended)

Docker is the easiest way to run the application locally with PostgreSQL.

#### Quick Start with Docker Compose

1. **Run the entire application (PostgreSQL + Next.js):**
```bash
# Development mode (with hot reload)
docker-compose -f docker-compose.dev.yml up

# Production mode
docker-compose up
```

2. Open [http://localhost:3000](http://localhost:3000) in your browser.

The application will:
- Automatically start PostgreSQL
- Run database migrations
- Seed the database (dev mode only)
- Start the Next.js server

#### Running PostgreSQL Only with Docker

If you want to run only PostgreSQL with Docker and run the Next.js app locally:

```bash
# Start PostgreSQL container
docker run --name jewellery_postgres \
  -e POSTGRES_USER=jewellery_user \
  -e POSTGRES_PASSWORD=jewellery_password \
  -e POSTGRES_DB=jewellery_db \
  -p 5432:5432 \
  -d postgres:16-alpine
```

Or using Docker Compose:
```bash
# Start only PostgreSQL service
docker-compose up postgres -d
```

Then set your `DATABASE_URL` environment variable:
```bash
export DATABASE_URL="postgresql://jewellery_user:jewellery_password@localhost:5432/jewellery_db?schema=public"
```

#### Other PostgreSQL Options

**Using Homebrew (macOS):**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb jewellery_db
```

**Using apt (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo -u postgres createdb jewellery_db
```

**Using PostgreSQL official installer:**
Download from [postgresql.org](https://www.postgresql.org/download/) and follow installation instructions for your OS.

### Option 2: Manual Installation (Without Docker)

1. **Install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
```bash
cp env.example .env
# Edit .env and set your DATABASE_URL and JWT_SECRET
```

3. **Set up the database:**
```bash
# Generate Prisma Client
npm run db:generate

# Run migrations
npm run db:migrate

# Seed the database (optional)
npm run db:seed
```

4. **Copy images to public directory:**
```bash
# Images should be in public/img/
```

5. **Run the development server:**
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
├── app/                    # Next.js app directory
│   ├── page.tsx           # Home page
│   ├── shop/              # Shop page
│   ├── products/          # Product details
│   ├── cart/              # Shopping cart
│   ├── checkout/          # Checkout page
│   ├── wishlist/          # Wishlist page
│   ├── login/             # Login page
│   ├── register/          # Registration page
│   ├── contact/           # Contact page
│   └── account/           # User account page
├── components/            # React components
│   ├── ui/               # shadcn/ui components
│   ├── layout/           # Layout components (Header, Footer)
│   └── home/             # Home page components
├── lib/                   # Utilities and stores
│   ├── store.ts          # Zustand stores (cart, wishlist)
│   ├── utils.ts          # Utility functions
│   └── data.ts           # Mock product data
└── public/                # Static assets
    └── img/              # Product images
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run db:generate` - Generate Prisma Client
- `npm run db:push` - Push schema to database
- `npm run db:migrate` - Run database migrations
- `npm run db:studio` - Open Prisma Studio
- `npm run db:seed` - Seed the database

## Docker Configuration

### Overview

The project includes Docker configuration for both development and production environments:

- **Development**: `docker-compose.dev.yml` + `Dockerfile.dev` - Hot reload, development tools
- **Production**: `docker-compose.yml` + `Dockerfile` - Optimized multi-stage build

### Environment Variables

For production deployments, make sure to update the following in `docker-compose.yml`:

- `JWT_SECRET`: Change to a strong random secret (minimum 32 characters)
- `DATABASE_URL`: Update if using different database credentials
- `NODE_ENV`: Set to `production` for production deployments

You can also create a `.env` file in the project root and docker-compose will automatically load it:

```bash
# .env
JWT_SECRET=your-production-secret-here
DATABASE_URL=postgresql://user:password@postgres:5432/jewellery_db?schema=public
NODE_ENV=production
```

### Docker Configuration Details

#### Production Dockerfile (`Dockerfile`)
- ✅ Multi-stage build (deps → builder → runner)
- ✅ Uses Node.js 20 Alpine for smaller image size
- ✅ Generates Prisma Client during build
- ✅ Runs production build with `npm run build`
- ✅ Uses non-root user for security
- ✅ Copies standalone output from `.next/standalone` directory
- ✅ Includes Prisma schema for runtime migrations
- ✅ **Verified**: `next.config.ts` has `output: 'standalone'` configured correctly

#### Development Dockerfile (`Dockerfile.dev`)
- ✅ Single-stage build for faster iteration
- ✅ Includes dev dependencies
- ✅ Hot reload enabled
- ✅ Volume mounts for live code changes

#### Docker Compose Production (`docker-compose.yml`)
- ✅ PostgreSQL 16 Alpine with health checks
- ✅ App depends on postgres health
- ✅ Auto-runs Prisma migrations on startup
- ✅ Persistent data volumes
- ✅ Production environment variables

#### Docker Compose Development (`docker-compose.dev.yml`)
- ✅ Separate dev database volume
- ✅ Volume mounts for live code changes
- ✅ Auto-seeds database on first run
- ✅ Development environment with hot reload

## Docker Commands

### Development Mode

```bash
# Start services in development mode
docker-compose -f docker-compose.dev.yml up

# Start in background (detached mode)
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop services
docker-compose -f docker-compose.dev.yml down

# Rebuild and start
docker-compose -f docker-compose.dev.yml up --build
```

### Production Mode

```bash
# Build and start services
docker-compose up --build

# Start in background
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

### Database Only

```bash
# Start only PostgreSQL
docker-compose up postgres -d

# Stop PostgreSQL
docker-compose stop postgres

# Remove PostgreSQL container and volume
docker-compose down postgres -v
```

### Cleanup

```bash
# Remove all containers, networks, and volumes
docker-compose -f docker-compose.dev.yml down -v
docker-compose down -v

# Remove unused Docker resources
docker system prune -a
```

## Features in Detail

### Product Pages
- Product listing with filters and sorting
- Product details with image gallery
- Product reviews and ratings
- Related products

### Shopping Experience
- Persistent shopping cart (localStorage)
- Wishlist functionality
- Quick add to cart from product cards
- Cart quantity management

### User Features
- User authentication (login/register)
- User account management
- Order history
- Saved addresses
- Payment methods

### Modern UI Features
- Smooth page transitions
- Hover effects on products
- Animated hero section
- Responsive navigation
- Mobile-friendly design

## Customization

### Colors
Edit the color variables in `app/globals.css` to customize the theme.

### Products
Update the `mockProducts` array in `lib/data.ts` or connect to your API.

### Store Configuration
Modify the Zustand stores in `lib/store.ts` to customize cart and wishlist behavior.

## License

MIT License - feel free to use this project for your own purposes.

## Support

For issues and questions, please open an issue on GitHub.