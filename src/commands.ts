import type { BotCommand } from '@towns-protocol/bot'

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'time',
        description: 'Get the current time',
    },
    {
        name: 'drop',
        description:
            'Create airdrop: /drop fixed <amount> or /drop reaction <total>. TOWNS only.',
    },
    {
        name: 'drop_close',
        description: 'Close a reaction airdrop and distribute: /drop_close <messageId>',
    },
] as const satisfies BotCommand[]

export default commands
