import type { BotCommand } from '@towns-protocol/bot'

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
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
