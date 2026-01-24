# Quickstart Bot

A simple, barebones bot example perfect for beginners learning to build Towns bots.

# Features

- **Slash commands**: `/help`, `/drop`, `/drop_close`
- **$TOWNS airdrops**: `/drop fixed` (all channel members) or `/drop reaction` (🤭 reactors)

## Slash Commands

- `/help` - Show available commands
- `/drop fixed <amount>` - Airdrop each channel member a fixed amount of $TOWNS
- `/drop reaction <total>` - Airdrop $TOWNS split among users who react 🤭; then `/drop_close <messageId>` to distribute
- `/drop_close <messageId>` - Close a reaction airdrop and send $TOWNS to reactors

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
- `/drop fixed <amount>` or `/drop reaction <total>` - Create an airdrop
- `/drop_close <messageId>` - Close a reaction airdrop and distribute

# Code Structure

The bot consists of two main files:

## `src/commands.ts`

Defines the slash commands available to users. Commands registered here appear in the slash command menu.

## `src/index.ts`

Main bot logic with:

1. **Bot initialization** (`makeTownsBot`) - Creates bot instance with credentials and commands
2. **Slash command handlers** (`onSlashCommand`) - Handle `/help`, `/drop`, `/drop_close`
3. **Reaction handler** (`onReaction`) - Track 🤭 reactors for reaction airdrops
4. **Interaction response handler** (`onInteractionResponse`) - Forms and transaction confirmations
5. **Bot server setup** (`bot.start()`) - Starts the bot server with a Hono HTTP server

## Extending this Bot

To add your own features:

1. **Add a slash command:**
   - Add to `src/commands.ts`
   - Go to `src/index.ts` and create a handler with `bot.onSlashCommand('yourcommand', async (handler, event) => { ... })`

2. **Handle more events:**
   - Use `bot.onReaction()`, `bot.onMessageEdit()`, `bot.onChannelJoin()`, etc.
