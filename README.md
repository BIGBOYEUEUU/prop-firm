# TRD-WISE Backend API

Full-stack Node.js backend for the TRD-WISE Kenya prop trading evaluation platform.

## Stack
- **Runtime**: Node.js 20 + Express
- **Database**: Supabase (Postgres + Auth + RLS)
- **Payments**: M-PESA Daraja API (STK Push)
- **Deploy**: Railway (recommended), Render, or any Docker host

---

## Quick Start

### 1. Clone and install
```bash
git clone <your-repo>
cd trdwise
npm install
```

### 2. Set up Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run `supabase/migrations/001_schema.sql`
3. Copy your project URL and keys

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your actual values
```

Required variables:
| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase project Settings → API |
| `SUPABASE_ANON_KEY` | Supabase project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase project Settings → API |
| `JWT_SECRET` | Generate: `openssl rand -hex 64` |
| `MPESA_CONSUMER_KEY` | [Safaricom Developer Portal](https://developer.safaricom.co.ke) |
| `MPESA_CONSUMER_SECRET` | Safaricom Developer Portal |
| `MPESA_SHORTCODE` | `174379` for sandbox |
| `MPESA_PASSKEY` | Safaricom Developer Portal |
| `MPESA_CALLBACK_URL` | Your public URL + `/api/wallet/mpesa/callback` |

### 4. Run locally
```bash
npm run dev
# API available at http://localhost:3000
```

### 5. Add password_hash column
The schema uses a `password_hash` column on users. Add it in Supabase SQL Editor:
```sql
alter table users add column if not exists password_hash text;
alter table evaluations add column if not exists mt5_login bigint;
```

---

## Deploy to Railway

1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard
4. Railway auto-detects the Dockerfile and deploys
5. Get your public URL and update `MPESA_CALLBACK_URL`

---

## API Reference

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Register new trader |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Get current user |
| PATCH | `/api/auth/me` | Update profile |
| POST | `/api/auth/verify-university` | Verify university email |

### Evaluations
| Method | Path | Description |
|---|---|---|
| GET | `/api/evaluations` | List my evaluations |
| POST | `/api/evaluations` | Create new evaluation |
| GET | `/api/evaluations/:id` | Full evaluation detail + metrics |
| GET | `/api/evaluations/:id/rules` | Live rules monitor |
| POST | `/api/evaluations/:id/check` | Trigger rule check |

### Wallet (M-PESA)
| Method | Path | Description |
|---|---|---|
| POST | `/api/wallet/pay` | Initiate STK Push |
| GET | `/api/wallet/status/:tx_id` | Poll payment status |
| POST | `/api/wallet/mpesa/callback` | Safaricom webhook (auto) |
| GET | `/api/wallet/history` | Transaction history |

### Trades
| Method | Path | Description |
|---|---|---|
| GET | `/api/trades` | List trades (filterable) |
| POST | `/api/trades` | Submit trade (manual entry) |
| PATCH | `/api/trades/:id/close` | Close a trade |
| GET | `/api/trades/analytics/:eval_id` | Analytics for evaluation |
| POST | `/api/trades/mt5-sync` | MT5 bridge webhook |

### Education
| Method | Path | Description |
|---|---|---|
| GET | `/api/education/courses` | List published courses |
| POST | `/api/education/courses/:id/complete` | Mark course complete |
| GET | `/api/education/seminars` | List seminars |
| POST | `/api/education/seminars/:id/register` | Register for seminar |
| GET | `/api/education/certificates` | My certificates |
| GET | `/api/education/verify/:code` | Verify certificate (public) |

### University Arena
| Method | Path | Description |
|---|---|---|
| GET | `/api/arena/current` | Current competition + my entry |
| GET | `/api/arena/:id/leaderboard` | Anonymised leaderboard |
| POST | `/api/arena/:id/enter` | Enter competition |

### Support
| Method | Path | Description |
|---|---|---|
| GET | `/api/support` | My tickets |
| POST | `/api/support` | Create ticket |
| GET | `/api/support/:id` | Ticket + messages |
| POST | `/api/support/:id/reply` | Reply to ticket |

### Admin (role-protected)
| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/stats` | Platform dashboard stats |
| GET | `/api/admin/users` | All users |
| PATCH | `/api/admin/users/:id` | Update user role/status |
| GET | `/api/admin/evaluations` | All evaluations |
| POST | `/api/admin/evaluations/:id/advance` | Advance Phase 1 → Phase 2 |
| GET | `/api/admin/tiers` | Tier configuration |
| PATCH | `/api/admin/tiers/:tier_key` | Update tier rules |
| GET | `/api/admin/university-domains` | Approved domains |
| POST | `/api/admin/university-domains` | Add university |
| GET | `/api/admin/audit` | Audit log |

---

## Evaluation Engine

The core engine (`src/engine/evaluationEngine.js`) enforces rules automatically:

### Rule Models
- **Drawdown models**: `static` (from initial balance), `trailing` (from peak equity), `hybrid`
- **Daily DD modes**: `A` (from start-of-day balance), `B` (from intraday peak), `C` (fixed from initial)

### Automated checks
- **Every 5 minutes** (cron): checks all active evaluations for calendar expiry and open-position breaches
- **On every trade close**: immediate rule check triggered
- **Midnight EAT**: daily drawdown reset for all active evaluations

### Breach → locked instantly
When a breach is detected, `status` flips to `breached` and the breach detail (rule, value, timestamp) is logged. Trader cannot add more trades.

### Pass conditions
- Phase 1: `profit% >= phase1_target` AND `trading_days >= min_days` AND `daily_dd < limit` AND `overall_dd < limit`
- Phase 2: same check against `phase2_target` → status flips to `funded`

---

## MT5 Bridge Integration (Phase 2)

When you have an MT5 server:
1. Build or use a Node.js MT5 Manager API client
2. On trade events (open/close/update), POST to `/api/trades/mt5-sync`
3. Set `MT5_BRIDGE_SECRET` in `.env` and send it as `x-mt5-secret` header
4. Store `mt5_login` on the evaluation record to link accounts

---

## M-PESA Testing

Use sandbox credentials from [developer.safaricom.co.ke](https://developer.safaricom.co.ke).

For the callback URL in development, use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Use the https URL as MPESA_CALLBACK_URL
```

Test phone: `254708374149` (Safaricom sandbox test number)

---

## Connecting the Frontend

In your `trdwise-platform.html`, replace all static data with API calls.

Example — login:
```javascript
const res = await fetch('https://your-api.railway.app/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const { token, user } = await res.json();
localStorage.setItem('trdwise_token', token);
```

Example — authenticated request:
```javascript
const token = localStorage.getItem('trdwise_token');
const res = await fetch('/api/evaluations', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

---

## Roles
| Role | Access |
|---|---|
| `trader` | Own data only |
| `support_admin` | All tickets |
| `risk_admin` | Evaluations, users, tiers |
| `education_admin` | Courses, seminars |
| `payments_admin` | Transactions, stats |
| `university_admin` | Arena, domains |
| `super_admin` | Everything |
