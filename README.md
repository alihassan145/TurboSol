## TurboSol Telegram Sniper Bot

Node.js Telegram bot for Solana token sniping using Jupiter aggregator.

### Prerequisites

- Node.js 18+
- A Telegram bot token from @BotFather
- A Solana wallet secret key in Base58 (fund with SOL)

### Setup

1. Install deps:
   ```bash
   npm i
   ```
2. Copy env and fill secrets:
   ```bash
   cp env.sample .env
   # edit .env and set TELEGRAM_BOT_TOKEN and WALLET_PRIVATE_KEY_BASE58
   ```
3. Start the bot:
   ```bash
   npm run dev
   ```

### Usage in Telegram

- /start → shows main menu
- Quote: `quote <MINT> <amount SOL>`
- Quick Buy: `buy <MINT> <amount SOL>`
- Snipe LP: `snipe <MINT> <amount SOL>`
- Stop Snipe: via menu

Advanced runtime commands

- `rpc list` | `rpc add <URL>` | `rpc rotate`
- `grpc set <host:port>` (Jito gRPC)
- `fee <lamports>` sets priority fee (empty or 0 -> auto)
- `jito on` | `jito off`
- buy/snipe flags: `buy <MINT> <SOL> fee=5000 jito=1`

Notes:

- Uses Jupiter v6 quote/swap. Prioritization fee set to auto. Wraps SOL.
- LP snipe is a heuristic (checks for quote availability periodically).
- Multi-RPC with rotation on failure and manual rotate.
- Optional Jito bundle submission via gRPC (proto in `protos/bundle.proto`).
