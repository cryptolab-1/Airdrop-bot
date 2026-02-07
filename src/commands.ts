import type { BotCommand } from '@towns-protocol/bot'

// Slash commands registered to the bot
const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'drop',
        description:
            'Launch Airdrop App',
    },
] as const satisfies BotCommand[]

export default commands
