# EVLotBot

A Telegram bot that notifies you when EV charging spots become available at Singapore car parks.

Data is sourced from the [LTA DataMall](https://datamall.lta.gov.sg/) and polled on a configurable interval. When a charger you're subscribed to becomes available, you get an instant Telegram alert.

Try it here : [EVLotBot](https://t.me/sglotbot?start=start)

## Features

- Search for EV chargers by typing any name, address, or postal code
- **Find nearby chargers** — share your location to see the 10 nearest EV charging spots on a static map, with a link to an interactive OneMap
- **Sort nearby results** by distance or cheapest price
- Subscribe to AC or DC charger availability alerts
- Alerts include location, operator, address, Google Maps link, position (e.g. level/lot), charger type, and pricing
- **Static map images** for venue details and nearby search results (OneMap Static Map API)
- **Interactive map link** (OneMap AMM) with colour-coded markers in nearby results
- Live charger counts shown when browsing (e.g. 2/5 available)
- Pricing displayed per charger type, including ranges (e.g. $0.67–$0.83/kWh)
- Last-updated timestamp shown in venue detail and nearby views
- Automatically unsubscribes after an alert is delivered
- Supports multiple operators at the same location (Charge+, Eigen, FPNC, MNL, Shell, SP, Strides, Tesla, TotalEnergies, Volt, and more)
- Operator display names mapped from raw LTA strings to friendly labels
- Configurable subscription limits (global and per-user) via admin commands
- Rate limiting to prevent spam
- Location names and addresses automatically title-cased for display

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and usage guide |
| `/nearby` | Share your location to find the 10 nearest EV charging spots |
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
2. Every 5 minutes, it re-fetches the data and compares availability against the stored state. The LTA API uses a two-step fetch: a batch endpoint returns a signed link, which is then downloaded to get the full charger dataset. Transient failures are retried up to 3 times with exponential backoff (2 s, 4 s, 8 s).
3. Charging points at each location are grouped by operator. Each (location, operator) pair is tracked independently, so alerts are scoped to a specific operator's chargers.
4. When a charger transitions from unavailable to available, the change is recorded inside a single SQLite transaction. After the transaction commits, all subscribers are notified in batches (up to 30 messages at a time) and their subscriptions are removed.
5. If the charger becomes unavailable again, the notification flag resets so subscribers can be alerted next time it comes back up.
6. Notifications include the charger position (e.g. level/lot number), pricing where available, and a Google Maps link for the address.
7. Nearby search uses a flat-earth distance approximation inside SQLite (accurate to < 0.1 % within 50 km) with a ±0.5° bounding-box pre-filter, then computes precise haversine distances for display. Results are deduplicated by location name and can be re-sorted by cheapest price.

## Project Structure

```
src/
├── index.js       # Entry point — starts the bot, schedules cron polls
├── bot.js         # Telegraf bot — commands, callbacks, UI formatting
├── db.js          # SQLite schema, migrations, and all data access functions
├── geo.js         # Haversine distance, price parsing, sort-by-price helper
├── keyboards.js   # Inline-keyboard builders (search, subscriptions, nearby)
├── operators.js   # LTA operator raw-name → friendly display-name mapping
└── poller.js      # LTA API fetch, availability diff, notification dispatch
```

## Tech Stack

- [Telegraf](https://telegraf.js.org/) — Telegram bot framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local SQLite database
- [axios](https://axios-http.com/) — HTTP client for LTA API calls
- [node-cron](https://github.com/node-cron/node-cron) — poll scheduling
- [dotenv](https://github.com/motdotla/dotenv) — environment variable loading
- [@danielhaim/titlecaser](https://github.com/danielhaim/titlecaser) — title-casing for location names and addresses
