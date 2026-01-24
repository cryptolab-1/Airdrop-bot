# Quickstart Bot

A simple, barebones bot example perfect for beginners learning to build Towns bots.

# Features

- **Slash commands**: `/help`, `/drop`
- **$TOWNS airdrops**: `/drop <amount>` (total split among all channel members) or `/drop react <amount>` (💸 reactors). Creator reacts ❌ to cancel, 🚀 to launch. Distribution uses **Multicall3** batches (up to **80** transfers per tx); you sign **approve** once, then **1+ batch** tx(s).

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

# Usage

Once the bot is running, installed to a space and added to a channel:

**Try the slash commands:**

- `/help` - See all available commands
- `/drop <amount>` or `/drop react <amount>` - Create an airdrop
- Reaction airdrops: react 💸 to join, react ❌ (creator only) to cancel, 🚀 (creator only) to launch. You sign **approve** + **batch** tx(s) (up to 80 per batch).

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
