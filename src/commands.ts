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
            'Create airdrop: /drop <amount> or /drop react <amount>. TOWNS only.',
    },
] as const satisfies BotCommand[]

export default commands
