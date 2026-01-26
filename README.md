# Quickstart Bot

A simple, barebones bot example perfect for beginners learning to build Towns bots.

# Features

- **Slash commands**: `/help`, `/drop`
- **$TOWNS airdrops**: `/drop <amount>` (total split among all channel members) or `/drop react <amount>` (💸 reactors). Creator reacts ❌ to cancel, 🚀 to launch. Distribution uses **Multicall3** to batch transfers (up to **80** transfers per tx); you sign **1+ batch** tx(s) directly from your wallet (no approval needed).

## Slash Commands

- `/help` - Show available commands
- `/drop <amount>` - Airdrop total $TOWNS split among all channel members
- `/drop react <amount>` - Airdrop $TOWNS split among users who react 💸 to join; creator reacts ❌ to cancel, 🚀 to launch

# Setup

1. Copy `.env.sample` to `.env` and fill in your credentials:

   ```bash
   cp .env.sample .env
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Run the bot:
   ```bash
   bun run dev
   ```

# Environment Variables

Required variables in `.env`:

- `APP_PRIVATE_DATA` - Your Towns app private data (base64 encoded)
- `JWT_SECRET` - JWT secret for webhook authentication
- `PORT` - Port to run the bot on (optional, defaults to 5123)

Optional:

- `AIRDROP_EXCLUDE_ADDRESSES` - Comma-separated addresses to exclude from fixed `/drop` (e.g. other bots in the chat). The airdrop bot excludes its own addresses automatically; use this to exclude additional wallets such as another bot’s gas wallet.

**Fixed drop recipients** – The bot determines who receives a fixed `/drop` in this order: (1) **Membership NFT** – If the event's `spaceId` is the space's contract address (0x…), the bot uses on-chain membership NFT holders (everyone who joined that town and minted a membership). (2) **Channel / space API** – Otherwise it uses channel members, then space members from the API. For full eligibility use a context where `spaceId` is the space contract address when available.

# Usage

Once the bot is running, installed to a space and added to a channel:

**Try the slash commands:**

- `/help` - See all available commands
- `/drop <amount>` or `/drop react <amount>` - Create an airdrop
- Reaction airdrops: react 💸 to join, react ❌ (creator only) to cancel, 🚀 (creator only) to launch. You sign **1+ batch** tx(s) (up to 80 transfers per tx).

# Code Structure

The bot consists of two main files:

## `src/commands.ts`

Defines the slash commands available to users. Commands registered here appear in the slash command menu.

## `src/index.ts`

Main bot logic with:

1. **Bot initialization** (`makeTownsBot`) - Creates bot instance with credentials and commands
2. **Slash command handlers** (`onSlashCommand`) - Handle `/help`, `/drop`
3. **Reaction handler** (`onReaction`) - Track 💸 join, ❌ cancel, 🚀 launch for reaction airdrops
4. **Interaction response handler** (`onInteractionResponse`) - Forms and transaction confirmations
5. **Bot server setup** (`bot.start()`) - Starts the bot server with a Hono HTTP server

## Extending this Bot

To add your own features:

1. **Add a slash command:**
   - Add to `src/commands.ts`
   - Go to `src/index.ts` and create a handler with `bot.onSlashCommand('yourcommand', async (handler, event) => { ... })`

2. **Handle more events:**
   - Use `bot.onReaction()`, `bot.onMessageEdit()`, `bot.onChannelJoin()`, etc.
