# $TOWNS Airdrop Mini App

A Farcaster mini app for distributing $TOWNS tokens to NFT holders on Base.

## Features

- **Fixed Airdrops**: Distribute tokens to all membership NFT holders
- **React Airdrops**: Let users join by clicking, then distribute to participants
- **Real-time Updates**: WebSocket-powered live participant list
- **Single Transaction**: Users sign once to deposit, bot handles distribution
- **Beautiful UI**: Modern React interface with Tailwind CSS

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Towns Client                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              React Mini App (iframe)                 │   │
│  │  - Create airdrop form                              │   │
│  │  - Real-time participant list                       │   │
│  │  - Wallet integration via Farcaster SDK             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ REST API + WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend Server (Hono)                     │
│  - /api/holders          - Get NFT holder count             │
│  - /api/airdrop          - Create airdrop                   │
│  - /api/airdrop/:id      - Get status                       │
│  - /api/airdrop/:id/join - Join (react mode)                │
│  - /api/airdrop/:id/launch - Launch distribution            │
│  - /ws                   - Real-time updates                │
│  - /.well-known/farcaster.json - Mini app manifest          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ ERC-7821 execute()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Base Chain                            │
│  - $TOWNS Token (0x00000000A22C618fd6b4D7E9A335C4B96B189a38) │
│  - Membership NFT Contract                                   │
│  - Bot Treasury (smart account)                              │
└─────────────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Towns bot credentials (from [app.towns.com/developer](https://app.towns.com/developer))
- Farcaster account (for mini app manifest)

### Installation

```bash
# Clone and install
git clone <repo>
cd airdrop-bot
bun install

# Install mini app dependencies
cd miniapp
bun install
cd ..
```

### Configuration

1. Copy `.env.sample` to `.env`:
   ```bash
   cp .env.sample .env
   ```

2. Fill in required values:
   - `APP_PRIVATE_DATA`: Bot credentials from Towns developer portal
   - `JWT_SECRET`: Random string (min 32 chars)
   - `AIRDROP_MEMBERSHIP_NFT_ADDRESS`: Your space's membership NFT contract
   - `MINIAPP_URL`: Your deployed URL (for manifest)

3. Generate Farcaster manifest signature:
   - Go to [developers.farcaster.xyz](https://developers.farcaster.xyz)
   - Generate account association for your domain
   - Add `FARCASTER_MANIFEST_*` values to `.env`

### Development

```bash
# Terminal 1: Run API server
bun run dev

# Terminal 2: Run mini app dev server
cd miniapp
bun run dev
```

The mini app dev server proxies API requests to the backend.

### Production Build

```bash
# Build mini app
cd miniapp
bun run build
cd ..

# Start production server (serves both API and static files)
bun run start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_PRIVATE_DATA` | Yes | Bot credentials |
| `JWT_SECRET` | Yes | Webhook security (min 32 chars) |
| `AIRDROP_MEMBERSHIP_NFT_ADDRESS` | Yes | NFT contract for eligibility |
| `MINIAPP_URL` | Production | Public deployment URL |
| `FARCASTER_MANIFEST_*` | Production | Manifest signing credentials |
| `PORT` | No | Server port (default: 3000) |
| `AIRDROP_EXCLUDE_ADDRESSES` | No | Addresses to exclude (comma-separated) |
| `AIRDROP_NFT_TIMEOUT_MS` | No | NFT fetch timeout (default: 30000) |
| `AIRDROP_NFT_RETRIES` | No | NFT fetch retries (default: 3) |
| `AIRDROP_DISTRIBUTION_RETRIES` | No | Distribution retries (default: 4) |

## How It Works

### Fixed Airdrop Flow

1. Creator opens mini app, sees NFT holder count
2. Creator enters total amount, clicks "Create Airdrop"
3. Creator signs one transaction to deposit tokens to bot
4. Bot automatically distributes to all NFT holders
5. Real-time status updates via WebSocket

### React Airdrop Flow

1. Creator creates react airdrop with total amount
2. Creator signs deposit transaction
3. Users click "Join" button in mini app
4. Participant list updates in real-time
5. Creator clicks "Launch" when ready
6. Bot distributes to all participants

### Token Flow

```
Creator Wallet → (deposit) → Bot Treasury → (distribute) → Recipients
```

The bot uses ERC-7821 `execute()` for efficient batch transfers.

## Deployment

### Render

1. Create new Web Service
2. Connect repository
3. Set build command: `cd miniapp && bun install && bun run build && cd .. && bun install`
4. Set start command: `bun run start`
5. Add environment variables
6. Deploy

### Docker

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY . .

RUN bun install
RUN cd miniapp && bun install && bun run build

EXPOSE 3000
CMD ["bun", "run", "start"]
```

## License

MIT
