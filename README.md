# ServiceOps v5 — Integrated System

## 🔧 Alignment Changes Made

### Auth System (BREAKING CHANGE)
| Before (broken) | After (aligned) |
|---|---|
| JWT login with username/password | API key via `x-api-key` header |
| `AuthContext.jsx` with tokenRef | `services/api.js` with localStorage key |
| `LoginPage.jsx` | `SetupPage.jsx` (enter API key once) |
| `POST /api/admin/login` | ❌ Removed |
| `POST /api/admin/refresh` | ❌ Removed |

### API URL Fixes
| Frontend (before) | Backend (actual) | Status |
|---|---|---|
| `GET /api/admin/stats` | `GET /admin/stats` | ✅ Added new endpoint |
| `GET /api/admin/health` | `GET /admin/health` | ✅ Added new endpoint |
| `GET /api/admin/jobs` | `GET /jobs` | ✅ Fixed |
| `PATCH /api/admin/jobs/:id` | `PATCH /admin/jobs/:id` | ✅ Added override endpoint |
| `GET /api/admin/technicians` | `GET /admin/technicians` | ✅ Fixed + response shape |
| `PATCH /api/admin/technicians/:id` | `PATCH /admin/technicians/:id/verified` | ✅ Fixed |
| `GET /api/admin/wallets` | `GET /admin/wallets` | ✅ Added aggregate endpoint |
| `POST /api/admin/wallets/topup` | `POST /admin/wallets/topup` | ✅ Added endpoint |
| `GET /api/admin/conversations` | `GET /admin/conversations` | ✅ Added list endpoint |
| `GET /api/admin/settings` | `GET /admin/settings` | ✅ Fixed |
| `PATCH /api/admin/settings/:key` | `PATCH /admin/settings/:key` | ✅ Fixed |

### Response Shape Fixes
- `technicians`: backend now returns `{ technicians: [] }` with camelCase (`walletBalance`, `joinedAt`, `totalJobs`, `verified`, `skills`, `rating`)
- `jobs`: frontend reads `data.data` (backend: `{ data: [] }`)
- `wallets`: backend now returns `{ transactions: [] }` with camelCase

## 🚀 Setup

### Backend
```bash
cd backend
cp .env.example .env
# Edit .env — set DATABASE_URL, API_KEY, REDIS_URL, etc.
npm install
psql -U postgres -d serviceops -f ../migration.sql
node server.js
```

### Frontend
```bash
cd frontend
cp .env.example .env.local
# Optionally set VITE_API_URL if backend is not on localhost:8000
npm install
npm run dev
# Visit http://localhost:3000 — enter API key on first visit
```

### Production nginx
```nginx
location /admin    { proxy_pass http://backend:8000; }
location /jobs     { proxy_pass http://backend:8000; }
location /wallet   { proxy_pass http://backend:8000; }
location /conversations { proxy_pass http://backend:8000; }
location /technicians   { proxy_pass http://backend:8000; }
location /health   { proxy_pass http://backend:8000; }
location /webhook  { proxy_pass http://backend:8000; }
location /payment  { proxy_pass http://backend:8000; }
location /         { root /var/www/serviceops-frontend/dist; try_files $uri /index.html; }
```

## 📁 Structure

```
serviceops-v5-integrated/
├── backend/
│   ├── controllers/
│   │   ├── admin.controller.js     ← MODIFIED (added 7 new endpoints)
│   │   ├── jobs.controller.js      ← unchanged
│   │   ├── wallet.controller.js    ← unchanged
│   │   └── conversations.controller.js ← unchanged
│   ├── routes/
│   │   └── admin.routes.js         ← MODIFIED (added new routes)
│   └── ...                         ← all other files unchanged
├── frontend/
│   ├── src/
│   │   ├── services/api.js         ← NEW (replaces AuthContext api)
│   │   ├── context/ApiContext.jsx  ← NEW (replaced AuthContext.jsx)
│   │   ├── pages/
│   │   │   ├── SetupPage.jsx       ← NEW (replaces LoginPage.jsx)
│   │   │   ├── DashboardPage.jsx   ← FIXED (API URLs)
│   │   │   ├── JobsPage.jsx        ← FIXED (API URLs + response shape)
│   │   │   ├── TechniciansPage.jsx ← FIXED (API URLs + response shape)
│   │   │   ├── WalletsPage.jsx     ← FIXED (API URLs + response shape)
│   │   │   ├── ConversationsPage.jsx ← FIXED (API URLs)
│   │   │   └── SettingsPage.jsx    ← FIXED (API URLs)
│   │   ├── layouts/
│   │   │   ├── AppShell.jsx        ← FIXED (removed JWT auth refs)
│   │   │   └── Sidebar.jsx         ← FIXED (removed user/logout)
│   │   ├── App.jsx                 ← FIXED (no login gate)
│   │   └── hooks/useApi.js         ← FIXED (removed AuthContext dep)
│   └── vite.config.js              ← NEW (proxy config for all backend paths)
└── migration.sql                   ← NEW (complete production schema)
```

## 🗄️ Database Schema Overview

| Table | Purpose |
|---|---|
| `technicians` | Technician profiles with PostGIS location |
| `services` | Service type catalog |
| `technician_services` | Tech ↔ service junction |
| `jobs` | Full job lifecycle with all status timestamps |
| `job_offers` | Per-wave dispatch offer tracking |
| `job_logs` | Immutable audit trail |
| `conversations` | WhatsApp session state |
| `wallet_transactions` | Double-entry financial ledger |
| `payment_links` | Razorpay payment link tracking |
| `commission_rules` | Per-service commission overrides |
| `system_settings` | Live key-value config |
| `idempotency_keys` | Request deduplication |

## 🔐 Security Model

- **API Key**: Set `API_KEY=<strong_random_string>` in backend `.env`
- **Frontend**: Admin enters key once → stored in `localStorage` → sent as `x-api-key` header
- **All protected routes** require valid `x-api-key` (enforced by `middleware/authenticate.js`)
- **401 response** → frontend clears key and shows setup screen automatically
- **Rate limiting**: All admin endpoints are protected by `adminLimiter`
# serviceops
