import { makeTownsBot } from '@towns-protocol/bot'
import { waitForTransactionReceipt } from 'viem/actions'
import commands from './commands'
import {
    TOWNS_ADDRESS,
    type AnyBot,
    formatEther,
    parseEther,
    pendingDrops,
    reactionAirdrops,
    getChannelMemberIds,
    resolveMemberAddresses,
    distribute,
    encodeTransferToBot,
    refundCreator,
    isMoneyMouth,
    moneyMouthEmoji,
} from './airdrop'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n' +
            '• `/time` - Get the current time\n' +
            '• `/drop fixed <amount>` - Airdrop each channel member a fixed amount of $TOWNS\n' +
            '• `/drop reaction <total>` - Airdrop $TOWNS split among users who react 🤭\n' +
            '• `/drop_close <messageId>` - Close a reaction airdrop and distribute\n\n' +
            '**Message Triggers:**\n\n' +
            "• Mention me - I'll respond\n" +
            "• React with 👋 - I'll wave back\n" +
            '• Say "hello" - I\'ll greet you back\n' +
            '• Say "ping" - I\'ll show latency\n' +
            '• Say "react" - I\'ll add a reaction\n',
    )
})

bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

bot.onSlashCommand('drop', async (handler, event) => {
    const { channelId, userId, args, spaceId, isDm } = event
    if (isDm || !spaceId) {
        await handler.sendMessage(channelId, 'Use `/drop` in a space channel.')
        return
    }
    const mode = args[0]?.toLowerCase()
    const amountStr = args[1]
    if (mode !== 'fixed' && mode !== 'reaction') {
        await handler.sendMessage(
            channelId,
            'Usage: `/drop fixed <amount>` or `/drop reaction <total>`. Amounts in $TOWNS.',
        )
        return
    }
    let amount: number
    try {
        amount = parseFloat(amountStr ?? '')
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid')
    } catch {
        await handler.sendMessage(channelId, 'Provide a valid positive amount (e.g. `10` or `1.5`).')
        return
    }
    const totalRaw = parseEther(amount.toString())

    if (mode === 'fixed') {
        const userIds = await getChannelMemberIds(bot as AnyBot, channelId)
        const memberAddresses = await resolveMemberAddresses(bot as AnyBot, userIds)
        if (memberAddresses.length === 0) {
            await handler.sendMessage(
                channelId,
                'No channel members with linked wallets found. Try a channel others have joined.',
            )
            return
        }
        const total = totalRaw * BigInt(memberAddresses.length)
        pendingDrops.set(userId as `0x${string}`, {
            mode: 'fixed',
            totalRaw: total,
            channelId,
            spaceId,
            creatorId: userId as `0x${string}`,
            memberAddresses,
        })
        const formId = `drop-confirm-fixed-${Date.now()}`
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'form',
                id: formId,
                title: 'Confirm airdrop',
                components: [
                    { id: 'confirm', type: 'button', label: 'Confirm' },
                    { id: 'cancel', type: 'button', label: 'Cancel' },
                ],
                recipient: userId as `0x${string}`,
            },
            { threadId: event.threadId, replyId: event.eventId },
        )
        await handler.sendMessage(
            channelId,
            `Send **${formatEther(total)} $TOWNS** to fund the airdrop for **${memberAddresses.length}** members (` +
                `${formatEther(totalRaw)} each). Confirm above.`,
            { mentions: [{ userId, displayName: 'Creator' }] },
        )
        return
    }

    // reaction
    pendingDrops.set(userId as `0x${string}`, {
        mode: 'reaction',
        totalRaw,
        channelId,
        spaceId,
        creatorId: userId as `0x${string}`,
    })
    const formId = `drop-confirm-reaction-${Date.now()}`
    await handler.sendInteractionRequest(
        channelId,
        {
            type: 'form',
            id: formId,
            title: 'Confirm airdrop',
            components: [
                { id: 'confirm', type: 'button', label: 'Confirm' },
                { id: 'cancel', type: 'button', label: 'Cancel' },
            ],
            recipient: userId as `0x${string}`,
        },
        { threadId: event.threadId, replyId: event.eventId },
    )
    await handler.sendMessage(
        channelId,
        `Send **${formatEther(totalRaw)} $TOWNS** to fund the reaction airdrop. ` +
            `I'll post a message; users who react ${moneyMouthEmoji()} will share the total. Confirm above.`,
        { mentions: [{ userId, displayName: 'Creator' }] },
    )
})

bot.onSlashCommand('drop_close', async (handler, event) => {
    const { channelId, userId, args, isDm } = event
    const messageId = args[0]?.trim()
    if (!messageId) {
        await handler.sendMessage(channelId, 'Usage: `/drop_close <messageId>`. Use the airdrop message ID.')
        return
    }
    const airdrop = reactionAirdrops.get(messageId)
    if (!airdrop) {
        await handler.sendMessage(channelId, 'No reaction airdrop found for that message.')
        return
    }
    if (airdrop.creatorId.toLowerCase() !== userId.toLowerCase()) {
        await handler.sendMessage(channelId, 'Only the airdrop creator can close it.')
        return
    }
    const reactors = Array.from(airdrop.reactorIds)
    if (reactors.length === 0) {
        reactionAirdrops.delete(messageId)
        try {
            await refundCreator(bot as AnyBot, airdrop.creatorId, airdrop.totalRaw)
            await handler.sendMessage(
                channelId,
                'No one reacted. Airdrop cancelled; TOWNS refunded to creator.',
                { mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
        } catch (e) {
            await handler.sendMessage(
                channelId,
                `No reactors. Refund failed: ${e instanceof Error ? e.message : String(e)}. Creator may need a linked wallet.`,
                { mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
        }
        return
    }
    const recipientAddresses = await resolveMemberAddresses(bot as AnyBot, reactors)
    if (recipientAddresses.length === 0) {
        await handler.sendMessage(channelId, 'No reactors have linked wallets; cannot distribute.')
        return
    }
        try {
                await distribute(bot as AnyBot, recipientAddresses, airdrop.totalRaw, 'reaction')
    } catch (e) {
        await handler.sendMessage(
            channelId,
            `Airdrop distribution failed: ${e instanceof Error ? e.message : String(e)}`,
        )
        return
    }
    reactionAirdrops.delete(messageId)
    const per = airdrop.totalRaw / BigInt(recipientAddresses.length)
    await handler.sendMessage(
        channelId,
        `Airdrop closed. **${recipientAddresses.length}** recipients received **${formatEther(per)} $TOWNS** each.`,
    )
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt }) => {
    if (message.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (message.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (message.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId, messageId, userId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
        return
    }
    if (isMoneyMouth(reaction)) {
        const airdrop = reactionAirdrops.get(messageId)
        if (airdrop) airdrop.reactorIds.add(userId)
    }
})

bot.onInteractionResponse(async (handler, event) => {
    const { channelId, userId, response } = event
    const pl = response.payload.content
    if (pl?.case === 'form') {
        const form = pl.value
        const formId =
            (form as { requestId?: string }).requestId ?? (form as { id?: string }).id
        if (!formId?.startsWith('drop-confirm-')) return
        const pending = pendingDrops.get(userId as `0x${string}`)
        if (!pending) return
        let confirmed = false
        for (const c of form.components ?? []) {
            if (c.component?.case === 'button' && c.id === 'confirm') {
                confirmed = true
                break
            }
            if (c.component?.case === 'button' && c.id === 'cancel') {
                pendingDrops.delete(userId as `0x${string}`)
                await handler.sendMessage(channelId, 'Airdrop cancelled.')
                return
            }
        }
        if (!confirmed) return
        const creatorWallet = await resolveMemberAddresses(bot as AnyBot, [userId]).then((a) => a[0])
        if (!creatorWallet) {
            pendingDrops.delete(userId as `0x${string}`)
            await handler.sendMessage(
                channelId,
                'You need a linked wallet to fund the airdrop.',
                { mentions: [{ userId, displayName: 'Creator' }] },
            )
            return
        }
        const data = encodeTransferToBot(bot.appAddress, pending.totalRaw)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-tx-${Date.now()}`,
                title: 'Fund airdrop',
                subtitle: `Send ${formatEther(pending.totalRaw)} $TOWNS`,
                tx: {
                    chainId: '8453',
                    to: TOWNS_ADDRESS as `0x${string}`,
                    value: '0',
                    data,
                    signerWallet: creatorWallet,
                },
                recipient: userId as `0x${string}`,
            },
            { threadId: event.threadId },
        )
        await handler.sendMessage(
            channelId,
            'Sign the transaction to send $TOWNS to the bot. Once confirmed, I\'ll continue.',
            { mentions: [{ userId, displayName: 'Creator' }] },
        )
        return
    }

    if (pl?.case === 'transaction') {
        const tx = pl.value as { requestId: string; txHash?: string; error?: string }
        const pending = pendingDrops.get(userId as `0x${string}`)
        if (!pending) return
        if (tx.error) {
            pendingDrops.delete(userId as `0x${string}`)
            await handler.sendMessage(
                channelId,
                `Transaction rejected: ${tx.error}`,
                { mentions: [{ userId, displayName: 'Creator' }] },
            )
            return
        }
        if (!tx.txHash) return
        let receipt: { status: string }
        try {
            receipt = await waitForTransactionReceipt(bot.viem, { hash: tx.txHash as `0x${string}` })
        } catch (e) {
            pendingDrops.delete(userId as `0x${string}`)
            await handler.sendMessage(
                channelId,
                `Failed to verify transaction: ${e instanceof Error ? e.message : String(e)}`,
            )
            return
        }
        if (receipt.status !== 'success') {
            pendingDrops.delete(userId as `0x${string}`)
            await handler.sendMessage(channelId, 'Transaction failed on-chain.')
            return
        }
        const mode = pending.mode
        pendingDrops.delete(userId as `0x${string}`)

        if (mode === 'fixed' && pending.memberAddresses && pending.memberAddresses.length > 0) {
            try {
                await distribute(bot as AnyBot, pending.memberAddresses, pending.totalRaw, 'fixed')
            } catch (e) {
                await handler.sendMessage(
                    channelId,
                    `Distribution failed: ${e instanceof Error ? e.message : String(e)}`,
                )
                return
            }
            const per = pending.totalRaw / BigInt(pending.memberAddresses.length)
            await handler.sendMessage(
                channelId,
                `Airdrop done. **${pending.memberAddresses.length}** members received **${formatEther(per)} $TOWNS** each.`,
            )
            return
        }

        if (mode === 'reaction') {
            const { eventId: msgEventId } = await handler.sendMessage(
                channelId,
                `**$TOWNS Airdrop** · React ${moneyMouthEmoji()} to join. Total: **${formatEther(pending.totalRaw)} $TOWNS**. Creator: <@${pending.creatorId}>.`,
                { mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            reactionAirdrops.set(msgEventId, {
                totalRaw: pending.totalRaw,
                creatorId: pending.creatorId,
                channelId: pending.channelId,
                reactorIds: new Set(),
            })
            await handler.sendMessage(
                channelId,
                `Airdrop live. Message ID: \`${msgEventId}\`. React ${moneyMouthEmoji()} to join, then \`/drop_close ${msgEventId}\` to distribute.`,
                { mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
        }
    }
})

const app = bot.start()

app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

export default app
