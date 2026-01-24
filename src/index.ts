import { makeTownsBot } from '@towns-protocol/bot'
import { waitForTransactionReceipt } from 'viem/actions'
import commands from './commands'
import {
    TOWNS_ADDRESS,
    type AnyBot,
    formatEther,
    parseEther,
    pendingDrops,
    pendingCloseDistributes,
    reactionAirdrops,
    getChannelMemberIds,
    resolveMemberAddresses,
    encodeTransfer,
    isJoinReaction,
    joinEmoji,
} from './airdrop'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n\n' +
            '• `/drop <amount>` - Airdrop each channel member that amount of $TOWNS\n\n' +
            '• `/drop react <amount>` - Airdrop $TOWNS split among users who react 💸; react ❌ to cancel\n\n' +
            '• `/drop_close <messageId>` - Close a reaction airdrop and distribute',
    )
})

bot.onSlashCommand('drop', async (handler, event) => {
    const { channelId, userId, args, spaceId, isDm } = event
    if (isDm || !spaceId) {
        await handler.sendMessage(channelId, 'Use `/drop` in a space channel.')
        return
    }
    const first = args[0]?.toLowerCase()
    const isReact = first === 'react'
    const amountStr = isReact ? args[1] : args[0]
    if (!amountStr) {
        await handler.sendMessage(
            channelId,
            'Usage: `/drop <amount>` or `/drop react <amount>`. Amounts in $TOWNS.',
        )
        return
    }
    let amount: number
    try {
        amount = parseFloat(amountStr)
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid')
    } catch {
        await handler.sendMessage(channelId, 'Provide a valid positive amount (e.g. `10` or `1.5`).')
        return
    }
    const totalRaw = parseEther(amount.toString())

    if (!isReact) {
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
            `Approve **${formatEther(total)} $TOWNS** for the airdrop to **${memberAddresses.length}** members (` +
                `${formatEther(totalRaw)} each). Tokens stay in your wallet until distribution. Confirm above.`,
            { mentions: [{ userId, displayName: 'Creator' }] },
        )
        return
    }

    // react mode
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
        `I'll post an airdrop message; users who react ${joinEmoji()} will share **${formatEther(totalRaw)} $TOWNS**. You'll sign transfer(s) when you close. Confirm above.`,
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
        await handler.sendMessage(
            channelId,
            'No one reacted. Airdrop cancelled. Tokens remain in your wallet.',
            { mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
        )
        return
    }
    const recipientAddresses = await resolveMemberAddresses(bot as AnyBot, reactors)
    if (recipientAddresses.length === 0) {
        await handler.sendMessage(channelId, 'No reactors have linked wallets; cannot distribute.')
        return
    }
    const resolved = await resolveMemberAddresses(bot as AnyBot, [airdrop.creatorId]).then((a) => a[0])
    const creatorWallet = (resolved ?? airdrop.creatorId) as `0x${string}`
    const amountPer = airdrop.totalRaw / BigInt(recipientAddresses.length)
    pendingCloseDistributes.set(userId as `0x${string}`, {
        recipients: recipientAddresses,
        amountPer,
        channelId,
        messageId,
        creatorId: airdrop.creatorId,
        index: 0,
    })
    const data = encodeTransfer(recipientAddresses[0]!, amountPer)
    await handler.sendInteractionRequest(
        channelId,
        {
            type: 'transaction',
            id: `drop-close-tx-${Date.now()}`,
            title: 'Distribute $TOWNS',
            subtitle: `Transfer ${formatEther(amountPer)} $TOWNS (1 / ${recipientAddresses.length})`,
            tx: {
                chainId: '8453',
                to: TOWNS_ADDRESS as `0x${string}`,
                value: '0',
                data,
                signerWallet: creatorWallet,
            },
            recipient: userId as `0x${string}`,
        },
        { threadId: event.threadId, replyId: event.eventId },
    )
    await handler.sendMessage(
        channelId,
        `Sign **${recipientAddresses.length}** transfer(s) from your wallet (1 / ${recipientAddresses.length})…`,
        { mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
    )
})

const CANCEL_EMOJI = '❌'

bot.onReaction(async (handler, { reaction, channelId, messageId, userId }) => {
    if (reaction === CANCEL_EMOJI) {
        const airdrop = reactionAirdrops.get(messageId)
        if (airdrop && airdrop.creatorId.toLowerCase() === userId.toLowerCase()) {
            reactionAirdrops.delete(messageId)
            await handler.sendMessage(
                channelId,
                'Airdrop cancelled by creator. Tokens remain in your wallet.',
                { mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
            return
        }
    }
    if (isJoinReaction(reaction)) {
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
        const resolved = await resolveMemberAddresses(bot as AnyBot, [userId]).then((a) => a[0])
        const creatorWallet = (resolved ?? userId) as `0x${string}`
        pending.creatorWallet = creatorWallet

        if (pending.mode === 'reaction') {
            pendingDrops.delete(userId as `0x${string}`)
            const { eventId: msgEventId } = await handler.sendMessage(
                channelId,
                `**$TOWNS Airdrop** · React ${joinEmoji()} to join. Total: **${formatEther(pending.totalRaw)} $TOWNS**. Creator: <@${pending.creatorId}>. React ${CANCEL_EMOJI} to cancel.`,
                { mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            reactionAirdrops.set(msgEventId, {
                totalRaw: pending.totalRaw,
                creatorId: pending.creatorId,
                channelId: pending.channelId,
                reactorIds: new Set(),
            })
            await handler.sendReaction(channelId, msgEventId, joinEmoji())
            await handler.sendReaction(channelId, msgEventId, CANCEL_EMOJI)
            await handler.sendMessage(
                channelId,
                `Airdrop live. Message ID: \`${msgEventId}\`. React ${joinEmoji()} to join · React ${CANCEL_EMOJI} to cancel · \`/drop_close ${msgEventId}\` to distribute.`,
                { mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            return
        }

        pending.distributeRecipients = pending.memberAddresses!
        pending.distributeIndex = 0
        const amountPer = pending.totalRaw / BigInt(pending.memberAddresses!.length)
        const to = pending.memberAddresses![0]!
        const data = encodeTransfer(to, amountPer)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-fixed-tx-${Date.now()}-0`,
                title: 'Distribute $TOWNS',
                subtitle: `Transfer ${formatEther(amountPer)} $TOWNS (1 / ${pending.memberAddresses!.length})`,
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
            `Sign **${pending.memberAddresses!.length}** transfer(s) from your wallet (1 / ${pending.memberAddresses!.length})…`,
            { mentions: [{ userId, displayName: 'Creator' }] },
        )
        return
    }

    if (pl?.case === 'transaction') {
        const tx = pl.value as { requestId: string; txHash?: string; error?: string }
        const uid = userId as `0x${string}`

        const closeDist = pendingCloseDistributes.get(uid)
        if (closeDist) {
            if (tx.error) {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Transfer rejected: ${tx.error}. Airdrop still open; you can \`/drop_close ${closeDist.messageId}\` again.`,
                    { mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (!tx.txHash) return
            let receipt: { status: string }
            try {
                receipt = await waitForTransactionReceipt(bot.viem, { hash: tx.txHash as `0x${string}` })
            } catch (e) {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Failed to verify transfer: ${e instanceof Error ? e.message : String(e)}`,
                )
                return
            }
            if (receipt.status !== 'success') {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(channelId, 'Transfer failed on-chain. Airdrop not closed.')
                return
            }
            const next = closeDist.index + 1
            if (next >= closeDist.recipients.length) {
                pendingCloseDistributes.delete(uid)
                reactionAirdrops.delete(closeDist.messageId)
                await handler.sendMessage(
                    channelId,
                    `Airdrop closed. **${closeDist.recipients.length}** recipients received **${formatEther(closeDist.amountPer)} $TOWNS** each from your wallet.`,
                    { mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            closeDist.index = next
            const to = closeDist.recipients[next]!
            const data = encodeTransfer(to, closeDist.amountPer)
            const creatorWallet = (await resolveMemberAddresses(bot as AnyBot, [closeDist.creatorId]).then((a) => a[0]) ?? closeDist.creatorId) as `0x${string}`
            await handler.sendInteractionRequest(
                channelId,
                {
                    type: 'transaction',
                    id: `drop-close-tx-${Date.now()}-${next}`,
                    title: 'Distribute $TOWNS',
                    subtitle: `Transfer ${formatEther(closeDist.amountPer)} $TOWNS (${next + 1} / ${closeDist.recipients.length})`,
                    tx: {
                        chainId: '8453',
                        to: TOWNS_ADDRESS as `0x${string}`,
                        value: '0',
                        data,
                        signerWallet: creatorWallet,
                    },
                    recipient: uid,
                },
                { threadId: event.threadId },
            )
            await handler.sendMessage(
                channelId,
                `Sign transfer ${next + 1} / ${closeDist.recipients.length}…`,
                { mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
            )
            return
        }

        const pending = pendingDrops.get(uid)
        if (!pending) return
        if (tx.error) {
            pendingDrops.delete(uid)
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
            pendingDrops.delete(uid)
            await handler.sendMessage(
                channelId,
                `Failed to verify transaction: ${e instanceof Error ? e.message : String(e)}`,
            )
            return
        }
        if (receipt.status !== 'success') {
            pendingDrops.delete(uid)
            await handler.sendMessage(channelId, 'Transaction failed on-chain.')
            return
        }

        if (pending.distributeRecipients !== undefined && pending.creatorWallet) {
            const idx = (pending.distributeIndex ?? 0) + 1
            if (idx >= pending.distributeRecipients.length) {
                pendingDrops.delete(uid)
                const per = pending.totalRaw / BigInt(pending.distributeRecipients.length)
                await handler.sendMessage(
                    channelId,
                    `Airdrop done. **${pending.distributeRecipients.length}** members received **${formatEther(per)} $TOWNS** each from your wallet.`,
                )
                return
            }
            pending.distributeIndex = idx
            const to = pending.distributeRecipients[idx]!
            const amountPer = pending.totalRaw / BigInt(pending.distributeRecipients.length)
            const data = encodeTransfer(to, amountPer)
            await handler.sendInteractionRequest(
                channelId,
                {
                    type: 'transaction',
                    id: `drop-fixed-tx-${Date.now()}-${idx}`,
                    title: 'Distribute $TOWNS',
                    subtitle: `Transfer ${formatEther(amountPer)} $TOWNS (${idx + 1} / ${pending.distributeRecipients.length})`,
                    tx: {
                        chainId: '8453',
                        to: TOWNS_ADDRESS as `0x${string}`,
                        value: '0',
                        data,
                        signerWallet: pending.creatorWallet,
                    },
                    recipient: uid,
                },
                { threadId: event.threadId },
            )
            await handler.sendMessage(
                channelId,
                `Sign transfer ${idx + 1} / ${pending.distributeRecipients.length}…`,
                { mentions: [{ userId, displayName: 'Creator' }] },
            )
            return
        }

        const mode = pending.mode
    }
})

const app = bot.start()

app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

export default app
