# EVLotBot

A Telegram bot that notifies you when EV charging spots become available at Singapore car parks.

Data is sourced from the [LTA DataMall](https://datamall.lta.gov.sg/) and polled on a configurable interval. When a charger you're subscribed to becomes available, you get an instant Telegram alert.

Try it here : [EVLotBot](https://t.me/sglotbot?start=start)

## Features

- Search for EV chargers by typing any name, address, or postal code
- Subscribe to AC or DC charger availability alerts
- Alerts include location, operator, address, position (e.g. level/lot), charger type, and pricing
- Live charger counts shown when browsing (e.g. 2/5 available)
- Pricing displayed per charger type, including ranges (e.g. $0.67–$0.83/kWh)
- Last-updated timestamp shown in venue detail view
- Automatically unsubscribes after an alert is delivered
- Supports multiple operators at the same location (Charge+, Eigen, FPNC, MNL, Shell, SP, Strides, Tesla, TotalEnergies, Volt, and more)
- Configurable subscription limits (global and per-user) via admin commands
- Rate limiting to prevent spam

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and usage guide |
| `/subs` | View and manage your active subscriptions |
| _(free text)_ | Type any name, address, or postal code to search |

### Admin Commands

These commands are restricted to the configured admin chat ID.

| Command | Description |
|---|---|
| `/admin` | List all admin commands |
| `/adminsettings` | View subscription limits and current total |
| `/adminsubs` | List all subscriptions grouped by lot |
| `/setmaxsubs <n>` | Set the global subscription limit (default: 150) |
| `/setmaxperuser <n>` | Set the per-user subscription limit (default: 3) |

## Setup

### Prerequisites

- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An LTA DataMall API account key from [datamall.lta.gov.sg](https://datamall.lta.gov.sg/)

### Installation

```bash
git clone https://github.com/alwaysmod/EVLotBot.git
cd EVLotBot
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
BOT_TOKEN=your_telegram_bot_token
LTA_ACCOUNT_KEY=your_lta_account_key
ADMIN_CHAT_ID=your_telegram_admin_chat_id
```

### Run

```bash
npm start
```

## How It Works

1. On startup, EVLotBot fetches all EV charger locations from the LTA DataMall API and records baseline availability — no alerts are sent on the first run.
2. Every 5 minutes, it re-fetches the data and compares availability against the stored state. The LTA API uses a two-step fetch: a batch endpoint returns a signed link, which is then downloaded to get the full charger dataset. Transient failures are retried up to 3 times with exponential backoff (2s, 4s, 8s).
3. Charging points at each location are grouped by operator. Each (location, operator) pair is tracked independently, so alerts are scoped to a specific operator's chargers.
4. When a charger transitions from unavailable to available, all subscribers are notified in batches (up to 30 messages at a time) and their subscriptions are removed.
5. If the charger becomes unavailable again, the notification flag resets so subscribers can be alerted next time it comes back up.
6. Notifications include the charger position (e.g. level/lot number) and pricing where available.

## Tech Stack

- [Telegraf](https://telegraf.js.org/) — Telegram bot framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local SQLite database
- [axios](https://axios-http.com/) — HTTP client for LTA API calls
- [node-cron](https://github.com/node-cron/node-cron) — poll scheduling
- [dotenv](https://github.com/motdotla/dotenv) — environment variable loading
