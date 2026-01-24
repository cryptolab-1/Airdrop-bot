import { makeTownsBot } from '@towns-protocol/bot'
import { waitForTransactionReceipt } from 'viem/actions'
import commands from './commands'
import {
    TOWNS_ADDRESS,
    MULTICALL3_ADDRESS,
    MAX_TRANSFERS_PER_BATCH,
    type AnyBot,
    type ReactionAirdrop,
    formatEther,
    parseEther,
    pendingDrops,
    pendingCloseDistributes,
    reactionAirdrops,
    getChannelMemberIds,
    resolveMemberAddresses,
    encodeApprove,
    encodeAggregate3,
    chunkRecipients,
    deleteReactionAirdrop,
    findReactionAirdrop,
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
            `You'll approve **${formatEther(total)} $TOWNS**, then sign 1 or more batch tx(s) (up to **${MAX_TRANSFERS_PER_BATCH}** transfers per tx). Confirm above.`,
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
        `I'll post an airdrop message; users who react ${joinEmoji()} will share **${formatEther(totalRaw)} $TOWNS**. You'll approve + sign batch tx(s) when you close. Confirm above.`,
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
    const airdrop = findReactionAirdrop(messageId)
    if (!airdrop) {
        await handler.sendMessage(channelId, 'No reaction airdrop found for that message.')
        return
    }
    if (airdrop.creatorId.toLowerCase() !== userId.toLowerCase()) {
        await handler.sendMessage(channelId, 'Only the airdrop creator can close it.')
        return
    }
    const reactors = Array.from(airdrop.reactorIds)
    const threadId = airdrop.threadId
    if (reactors.length === 0) {
        deleteReactionAirdrop(airdrop)
        await handler.sendMessage(
            channelId,
            'No one reacted. Airdrop cancelled. Tokens remain in your wallet.',
            { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
        )
        return
    }
    const recipientAddresses = await resolveMemberAddresses(bot as AnyBot, reactors)
    if (recipientAddresses.length === 0) {
        await handler.sendMessage(channelId, 'No reactors have linked wallets; cannot distribute.', {
            threadId,
        })
        return
    }
    const creatorWallet = airdrop.creatorId as `0x${string}`
    const amountPer = airdrop.totalRaw / BigInt(recipientAddresses.length)
    const batches = chunkRecipients(recipientAddresses)
    pendingCloseDistributes.set(userId as `0x${string}`, {
        recipients: recipientAddresses,
        amountPer,
        channelId,
        messageId,
        followUpMessageId: airdrop.followUpMessageId,
        creatorId: airdrop.creatorId,
        creatorWallet,
        batches,
        batchIndex: -1,
        threadId,
    })
    const data = encodeApprove(MULTICALL3_ADDRESS, airdrop.totalRaw)
    await handler.sendInteractionRequest(
        channelId,
        {
            type: 'transaction',
            id: `drop-close-approve-${Date.now()}`,
            title: 'Approve $TOWNS',
            subtitle: `Approve ${formatEther(airdrop.totalRaw)} $TOWNS for batched distribute`,
            tx: {
                chainId: '8453',
                to: TOWNS_ADDRESS as `0x${string}`,
                value: '0',
                data,
            },
            recipient: userId as `0x${string}`,
        },
        { threadId, replyId: event.eventId },
    )
    await handler.sendMessage(
        channelId,
        `Sign **approve** tx, then **${batches.length}** batch tx(s) (up to ${MAX_TRANSFERS_PER_BATCH} per tx).`,
        { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
    )
})

const CANCEL_EMOJI = '❌'

bot.onReaction(async (handler, { reaction, channelId, messageId, userId }) => {
        if (reaction === CANCEL_EMOJI) {
        const airdrop = findReactionAirdrop(messageId)
        if (airdrop && airdrop.creatorId.toLowerCase() === userId.toLowerCase()) {
            deleteReactionAirdrop(airdrop)
            await handler.sendMessage(
                channelId,
                'Airdrop cancelled by creator. Tokens remain in your wallet.',
                { threadId: airdrop.threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
            return
        }
    }
    if (isJoinReaction(reaction)) {
        const airdrop = findReactionAirdrop(messageId)
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
        const creatorWallet = userId as `0x${string}`

        const { eventId: threadRootId } = await handler.sendMessage(
            channelId,
            `**$TOWNS Airdrop** — continue below.`,
            { mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
        )
        const threadId = threadRootId

        if (pending.mode === 'reaction') {
            pendingDrops.delete(userId as `0x${string}`)
            const { eventId: msgEventId } = await handler.sendMessage(
                channelId,
                `**$TOWNS Airdrop** · React ${joinEmoji()} to join. Total: **${formatEther(pending.totalRaw)} $TOWNS**. Creator: <@${pending.creatorId}>. React ${CANCEL_EMOJI} to cancel.`,
                { threadId, mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            const { eventId: followUpId } = await handler.sendMessage(
                channelId,
                `Airdrop live. Message ID: \`${msgEventId}\`. React ${joinEmoji()} to join · React ${CANCEL_EMOJI} to cancel · \`/drop_close ${msgEventId}\` to distribute.`,
                { threadId, mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            const airdrop: ReactionAirdrop = {
                totalRaw: pending.totalRaw,
                creatorId: pending.creatorId,
                channelId: pending.channelId,
                reactorIds: new Set(),
                airdropMessageId: msgEventId,
                followUpMessageId: followUpId,
                threadId,
            }
            reactionAirdrops.set(msgEventId, airdrop)
            reactionAirdrops.set(followUpId, airdrop)
            reactionAirdrops.set(threadId, airdrop)
            await handler.sendReaction(channelId, threadId, joinEmoji())
            await handler.sendReaction(channelId, threadId, CANCEL_EMOJI)
            await handler.sendReaction(channelId, msgEventId, joinEmoji())
            await handler.sendReaction(channelId, msgEventId, CANCEL_EMOJI)
            await handler.sendReaction(channelId, followUpId, joinEmoji())
            await handler.sendReaction(channelId, followUpId, CANCEL_EMOJI)
            return
        }

        const memberAddrs = pending.memberAddresses!
        const amountPer = pending.totalRaw / BigInt(memberAddrs.length)
        pending.creatorWallet = creatorWallet
        pending.batches = chunkRecipients(memberAddrs)
        pending.amountPer = amountPer
        pending.batchIndex = -1
        pending.threadId = threadId
        const data = encodeApprove(MULTICALL3_ADDRESS, pending.totalRaw)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-fixed-approve-${Date.now()}`,
                title: 'Approve $TOWNS',
                subtitle: `Approve ${formatEther(pending.totalRaw)} $TOWNS for batched airdrop`,
                tx: {
                    chainId: '8453',
                    to: TOWNS_ADDRESS as `0x${string}`,
                    value: '0',
                    data,
                },
                recipient: userId as `0x${string}`,
            },
            { threadId },
        )
        await handler.sendMessage(
            channelId,
            `Sign **approve** tx, then 1 or more **batch** tx(s) (up to ${MAX_TRANSFERS_PER_BATCH} per tx).`,
            { threadId, mentions: [{ userId, displayName: 'Creator' }] },
        )
        return
    }

    if (pl?.case === 'transaction') {
        const tx = pl.value as { requestId: string; txHash?: string; error?: string }
        const uid = userId as `0x${string}`

        const closeDist = pendingCloseDistributes.get(uid)
        if (closeDist) {
            const threadId = closeDist.threadId
            if (tx.error) {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Transaction rejected: ${tx.error}. Airdrop still open; you can \`/drop_close ${closeDist.messageId}\` again.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
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
                    `Failed to verify tx: ${e instanceof Error ? e.message : String(e)}. You can \`/drop_close ${closeDist.messageId}\` again.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (receipt.status !== 'success') {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(channelId, 'Transaction failed on-chain. Airdrop not closed.', {
                    threadId,
                })
                return
            }
            const isApprove = closeDist.batchIndex === -1
            if (isApprove) {
                closeDist.batchIndex = 0
            } else {
                closeDist.batchIndex += 1
            }
            if (closeDist.batchIndex >= closeDist.batches.length) {
                pendingCloseDistributes.delete(uid)
                reactionAirdrops.delete(closeDist.messageId)
                reactionAirdrops.delete(closeDist.followUpMessageId)
                reactionAirdrops.delete(closeDist.threadId)
                await handler.sendMessage(
                    channelId,
                    `Airdrop closed. **${closeDist.recipients.length}** recipients received **${formatEther(closeDist.amountPer)} $TOWNS** each from your wallet.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            const batch = closeDist.batches[closeDist.batchIndex]!
            const data = encodeAggregate3(closeDist.creatorWallet, batch, closeDist.amountPer)
            await handler.sendInteractionRequest(
                channelId,
                {
                    type: 'transaction',
                    id: `drop-close-batch-${Date.now()}-${closeDist.batchIndex}`,
                    title: 'Distribute $TOWNS (batch)',
                    subtitle: `Batch ${closeDist.batchIndex + 1} / ${closeDist.batches.length} (${batch.length} transfers)`,
                    tx: {
                        chainId: '8453',
                        to: MULTICALL3_ADDRESS as `0x${string}`,
                        value: '0',
                        data,
                    },
                    recipient: uid,
                },
                { threadId },
            )
            await handler.sendMessage(
                channelId,
                `Sign batch ${closeDist.batchIndex + 1} / ${closeDist.batches.length} (${batch.length} transfers)…`,
                { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
            )
            return
        }

        const pending = pendingDrops.get(uid)
        if (!pending) return
        const threadId = pending.threadId
        if (tx.error) {
            pendingDrops.delete(uid)
            await handler.sendMessage(
                channelId,
                `Transaction rejected: ${tx.error}`,
                { threadId, mentions: [{ userId, displayName: 'Creator' }] },
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
                { threadId },
            )
            return
        }
        if (receipt.status !== 'success') {
            pendingDrops.delete(uid)
            await handler.sendMessage(channelId, 'Transaction failed on-chain.', { threadId })
            return
        }

        const isApprove = pending.batchIndex === -1
        if (isApprove) {
            pending.batchIndex = 0
        } else {
            pending.batchIndex! += 1
        }
        const batches = pending.batches!
        const amountPer = pending.amountPer!
        if (pending.batchIndex! >= batches.length) {
            pendingDrops.delete(uid)
            const n = pending.memberAddresses!.length
            await handler.sendMessage(
                channelId,
                `Airdrop done. **${n}** members received **${formatEther(amountPer)} $TOWNS** each from your wallet.`,
                { threadId },
            )
            return
        }
        const batch = batches[pending.batchIndex!]!
        const data = encodeAggregate3(pending.creatorWallet!, batch, amountPer)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-fixed-batch-${Date.now()}-${pending.batchIndex}`,
                title: 'Distribute $TOWNS (batch)',
                subtitle: `Batch ${pending.batchIndex! + 1} / ${batches.length} (${batch.length} transfers)`,
                tx: {
                    chainId: '8453',
                    to: MULTICALL3_ADDRESS as `0x${string}`,
                    value: '0',
                    data,
                },
                recipient: uid,
            },
            { threadId },
        )
        await handler.sendMessage(
            channelId,
            `Sign batch ${pending.batchIndex! + 1} / ${batches.length} (${batch.length} transfers)…`,
            { threadId, mentions: [{ userId, displayName: 'Creator' }] },
        )
    }
})

const app = bot.start()

app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

export default app
