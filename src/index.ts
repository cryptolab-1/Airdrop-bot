import { makeTownsBot } from '@towns-protocol/bot'
import { readContract, waitForTransactionReceipt, writeContract } from 'viem/actions'
import type { Address } from 'viem'
import { erc20Abi } from 'viem'
import { multicall3Abi } from 'viem'
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
    encodeTransfer,
    encodeApprove,
    chunkRecipients,
    buildAggregate3TransferFromCalls,
    encodeAggregate3TransferFrom,
    deleteReactionAirdrop,
    findReactionAirdrop,
    isJoinReaction,
    joinEmoji,
} from './airdrop'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

/** Pending deposit: creator sent total to bot; we run distribution from bot. */
type PendingDeposit = {
    channelId: string
    threadId: string
    recipients: Address[]
    amountPer: bigint
    totalRaw: bigint
    creatorId: Address
    mode: 'fixed' | 'reaction'
    messageId?: string
}
const pendingDeposits = new Map<Address, PendingDeposit>()

function filterOutBotRecipients(addrs: Address[]): Address[] {
    const a = (bot.appAddress ?? '').toLowerCase()
    const b = (bot.botId ?? '').toLowerCase()
    if (!a && !b) return addrs
    return addrs.filter((x) => {
        const w = x.toLowerCase()
        return w !== a && w !== b
    })
}

function filterOutBotAndCreator(userIds: string[], creatorId: string): string[] {
    const creator = creatorId.toLowerCase()
    const botAddr = (bot.appAddress ?? '').toLowerCase()
    const botId = (bot.botId ?? '').toLowerCase()
    return userIds.filter((uid) => {
        const w = uid.toLowerCase()
        return w !== creator && w !== botAddr && w !== botId
    })
}

async function checkBalance(creator: Address, totalNeeded: bigint): Promise<{ ok: boolean; reason?: string }> {
    const balance = await readContract(bot.viem, {
        address: TOWNS_ADDRESS as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [creator],
    })

    if (balance < totalNeeded) {
        return {
            ok: false,
            reason: `Insufficient balance at ${creator.slice(0, 10)}...: have ${formatEther(balance)}, need ${formatEther(totalNeeded)} $TOWNS`,
        }
    }
    return { ok: true }
}

/** Run distribution from bot wallet after creator deposited total to bot. */
async function runBotDistribution(
    recipients: Address[],
    amountPer: bigint,
    totalRaw: bigint
): Promise<{ ok: boolean; error?: string }> {
    const from = bot.appAddress as Address | undefined
    if (!from) return { ok: false, error: 'Bot has no app address' }
    try {
        await writeContract(bot.viem, {
            address: TOWNS_ADDRESS as Address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [MULTICALL3_ADDRESS as Address, totalRaw],
        })
        const batches = chunkRecipients(recipients)
        for (const batch of batches) {
            const calls = buildAggregate3TransferFromCalls(from, batch, amountPer)
            await writeContract(bot.viem, {
                address: MULTICALL3_ADDRESS as Address,
                abi: multicall3Abi,
                functionName: 'aggregate3',
                args: [calls],
            })
        }
        return { ok: true }
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        }
    }
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n\n' +
            '• `/drop <amount>` - Airdrop total $TOWNS split among all channel members. You sign **once** to send the total to the bot; the bot distributes to everyone.\n\n' +
            '• `/drop react <amount>` - Airdrop $TOWNS split among users who react 💸 to join; creator reacts ❌ to cancel, 🚀 to launch. Same: sign once to send to the bot, then the bot distributes.',
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
        // Exclude only bot so creator can test in empty town (creator included)
        const filteredUserIds = userIds.filter((uid) => {
            const w = uid.toLowerCase()
            const a = (bot.appAddress ?? '').toLowerCase()
            const b = (bot.botId ?? '').toLowerCase()
            return w !== a && w !== b
        })
        if (filteredUserIds.length === 0) {
            await handler.sendMessage(
                channelId,
                'No channel members found (or only bot). Try a channel others have joined.',
            )
            return
        }
        let memberAddresses = await resolveMemberAddresses(bot as AnyBot, filteredUserIds)
        memberAddresses = filterOutBotRecipients(memberAddresses)
        if (memberAddresses.length === 0) {
            await handler.sendMessage(
                channelId,
                'No channel members found (or only bot). Try a channel others have joined.',
            )
            return
        }
        pendingDrops.set(userId as `0x${string}`, {
            mode: 'fixed',
            totalRaw,
            channelId,
            spaceId,
            creatorId: userId as `0x${string}`,
            memberAddresses,
        })
        const n = memberAddresses.length
        const per = totalRaw / BigInt(n)
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
            `You'll distribute **${formatEther(totalRaw)} $TOWNS** total, split among **${n}** members (**${formatEther(per)}** each). You'll sign **${n}** transfer tx(s). Confirm above.`,
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
        `I'll post an airdrop message; users who react ${joinEmoji()} will share **${formatEther(totalRaw)} $TOWNS**. You react 🚀 to launch, ❌ to cancel. Confirm above.`,
        { mentions: [{ userId, displayName: 'Creator' }] },
    )
})

const CANCEL_EMOJI = '❌'
const LAUNCH_EMOJI = '🚀'

function isLaunchReaction(r: string): boolean {
    if (r === LAUNCH_EMOJI) return true
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
    return ['rocket', 'launch'].some((s) => n(r) === n(s))
}

bot.onReaction(async (handler, event) => {
    const { reaction, channelId, messageId, userId } = event
    const airdrop = findReactionAirdrop(messageId)
    if (reaction === CANCEL_EMOJI) {
        if (airdrop && airdrop.creatorId.toLowerCase() === userId.toLowerCase()) {
            deleteReactionAirdrop(airdrop)
            await handler.sendMessage(
                channelId,
                'Airdrop cancelled by creator. Tokens remain in your wallet.',
                { threadId: airdrop.threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
        }
        return
    }
    if (isLaunchReaction(reaction) && airdrop && airdrop.creatorId.toLowerCase() === userId.toLowerCase()) {
        // Check if already in progress
        const existing = pendingCloseDistributes.get(userId as `0x${string}`)
        if (existing && existing.messageId === airdrop.airdropMessageId) {
            await handler.sendMessage(
                channelId,
                'Airdrop distribution already in progress. Wait for current batch to complete.',
                { threadId: airdrop.threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
            return
        }
        const threadId = airdrop.threadId
        const reactors = Array.from(airdrop.reactorIds)
        if (reactors.length === 0) {
            deleteReactionAirdrop(airdrop)
            await handler.sendMessage(
                channelId,
                'No one reacted. Airdrop cancelled. Tokens remain in your wallet.',
                { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
            return
        }
        let recipientAddresses = await resolveMemberAddresses(bot as AnyBot, reactors)
        recipientAddresses = filterOutBotRecipients(recipientAddresses)
        if (recipientAddresses.length === 0) {
            await handler.sendMessage(channelId, 'No reactors to distribute to (or only bot).', {
                threadId,
            })
            return
        }
        // Validate: recipient count should match reactor count (after filtering)
        if (recipientAddresses.length !== reactors.length) {
            await handler.sendMessage(
                channelId,
                `Warning: ${reactors.length} reactors but only ${recipientAddresses.length} valid addresses. Some reactors may not have linked wallets.`,
                { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
        }
        const amountPer = airdrop.totalRaw / BigInt(recipientAddresses.length)
        const botAddr = bot.appAddress as `0x${string}` | undefined
        if (!botAddr) {
            await handler.sendMessage(
                channelId,
                'Bot is not configured for airdrops. Contact support.',
                { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
            )
            return
        }
        await handler.sendMessage(
            channelId,
            `Distributing to **${recipientAddresses.length}** recipients. Sign **once** to send **${formatEther(airdrop.totalRaw)} $TOWNS** to the bot; the bot will then distribute to everyone.`,
            { threadId, mentions: [{ userId: airdrop.creatorId, displayName: 'Creator' }] },
        )
        pendingDeposits.set(userId as `0x${string}`, {
            channelId,
            threadId,
            recipients: recipientAddresses,
            amountPer,
            totalRaw: airdrop.totalRaw,
            creatorId: airdrop.creatorId,
            mode: 'reaction',
            messageId: airdrop.airdropMessageId,
        })
        const depositData = encodeTransfer(botAddr, airdrop.totalRaw)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-deposit-react-${Date.now()}`,
                title: 'Send $TOWNS to bot',
                subtitle: `Send ${formatEther(airdrop.totalRaw)} $TOWNS to the airdrop bot`,
                tx: {
                    chainId: '8453',
                    to: TOWNS_ADDRESS as `0x${string}`,
                    value: '0',
                    data: depositData,
                },
                recipient: userId as `0x${string}`,
            },
            { threadId, replyId: event.eventId },
        )
        return
    }
    if (isJoinReaction(reaction) && airdrop) {
        airdrop.reactorIds.add(userId)
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
                `**$TOWNS Airdrop** · React ${joinEmoji()} to join. Total: **${formatEther(pending.totalRaw)} $TOWNS**. Creator: <@${pending.creatorId}>. React ${CANCEL_EMOJI} to cancel · ${LAUNCH_EMOJI} to launch.`,
                { threadId, mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            const airdrop: ReactionAirdrop = {
                totalRaw: pending.totalRaw,
                creatorId: pending.creatorId,
                channelId: pending.channelId,
                reactorIds: new Set(),
                airdropMessageId: msgEventId,
                threadId,
            }
            reactionAirdrops.set(msgEventId, airdrop)
            reactionAirdrops.set(threadId, airdrop)
            await handler.sendReaction(channelId, threadId, joinEmoji())
            await handler.sendReaction(channelId, threadId, CANCEL_EMOJI)
            await handler.sendReaction(channelId, threadId, LAUNCH_EMOJI)
            await handler.sendReaction(channelId, msgEventId, joinEmoji())
            await handler.sendReaction(channelId, msgEventId, CANCEL_EMOJI)
            await handler.sendReaction(channelId, msgEventId, LAUNCH_EMOJI)
            return
        }

        const memberAddrs = pending.memberAddresses!
        const amountPer = pending.totalRaw / BigInt(memberAddrs.length)
        const botAddr = bot.appAddress as `0x${string}` | undefined
        pendingDrops.delete(userId as `0x${string}`)
        if (!botAddr) {
            await handler.sendMessage(
                channelId,
                'Bot is not configured for airdrops. Contact support.',
                { threadId, mentions: [{ userId, displayName: 'Creator' }] },
            )
            return
        }
        await handler.sendMessage(
            channelId,
            `Distributing to **${memberAddrs.length}** members. Sign **once** to send **${formatEther(pending.totalRaw)} $TOWNS** to the bot; the bot will then distribute to everyone.`,
            { threadId, mentions: [{ userId, displayName: 'Creator' }] },
        )
        pendingDeposits.set(userId as `0x${string}`, {
            channelId,
            threadId,
            recipients: memberAddrs,
            amountPer,
            totalRaw: pending.totalRaw,
            creatorId: pending.creatorId,
            mode: 'fixed',
        })
        const depositData = encodeTransfer(botAddr, pending.totalRaw)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-deposit-fixed-${Date.now()}`,
                title: 'Send $TOWNS to bot',
                subtitle: `Send ${formatEther(pending.totalRaw)} $TOWNS to the airdrop bot`,
                tx: {
                    chainId: '8453',
                    to: TOWNS_ADDRESS as `0x${string}`,
                    value: '0',
                    data: depositData,
                },
                recipient: userId as `0x${string}`,
            },
            { threadId },
        )
        return
    }

    if (pl?.case === 'transaction') {
        const tx = pl.value as { requestId?: string; id?: string; txHash?: string; error?: string }
        const uid = userId as `0x${string}`

        const dep = pendingDeposits.get(uid)
        if (dep) {
            const threadId = dep.threadId
            if (tx.error) {
                pendingDeposits.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Transaction rejected: ${tx.error}. You can try again.`,
                    { threadId, mentions: [{ userId: dep.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (!tx.txHash) return
            let receipt: { status: string }
            try {
                receipt = await waitForTransactionReceipt(bot.viem, { hash: tx.txHash as `0x${string}` })
            } catch (e) {
                pendingDeposits.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Failed to verify tx: ${e instanceof Error ? e.message : String(e)}.`,
                    { threadId, mentions: [{ userId: dep.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (receipt.status !== 'success') {
                pendingDeposits.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Deposit tx failed on-chain. [View tx](https://basescan.org/tx/${tx.txHash})`,
                    { threadId, mentions: [{ userId: dep.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            pendingDeposits.delete(uid)
            if (dep.mode === 'reaction' && dep.messageId) {
                reactionAirdrops.delete(dep.messageId)
                reactionAirdrops.delete(dep.threadId)
            }
            const result = await runBotDistribution(dep.recipients, dep.amountPer, dep.totalRaw)
            if (!result.ok) {
                await handler.sendMessage(
                    channelId,
                    `Deposit received but distribution failed: ${result.error}. Contact support — your ${formatEther(dep.totalRaw)} $TOWNS are in the bot.`,
                    { threadId, mentions: [{ userId: dep.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            await handler.sendMessage(
                channelId,
                `Airdrop done. **${dep.recipients.length}** recipients received **${formatEther(dep.amountPer)} $TOWNS** each.`,
                { threadId, mentions: [{ userId: dep.creatorId, displayName: 'Creator' }] },
            )
            return
        }

        const closeDist = pendingCloseDistributes.get(uid)
        if (closeDist) {
            const threadId = closeDist.threadId
            if (tx.error) {
                pendingCloseDistributes.delete(uid)
                await handler.sendMessage(
                    channelId,
                    `Transaction rejected: ${tx.error}. Airdrop still open; react ${LAUNCH_EMOJI} again to retry.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (!tx.txHash) {
                // Transaction submitted but hash not yet available - wait for next response with hash
                return
            }
            let receipt: { status: string }
            try {
                receipt = await waitForTransactionReceipt(bot.viem, { hash: tx.txHash as `0x${string}` })
            } catch (e) {
                pendingCloseDistributes.delete(uid)
                const txLink = tx.txHash ? ` [View tx](https://basescan.org/tx/${tx.txHash})` : ''
                await handler.sendMessage(
                    channelId,
                    `Failed to verify tx: ${e instanceof Error ? e.message : String(e)}.${txLink} React ${LAUNCH_EMOJI} again to retry.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            if (receipt.status !== 'success') {
                pendingCloseDistributes.delete(uid)
                const txLink = `https://basescan.org/tx/${tx.txHash}`
                const step =
                    closeDist.batchIndex === -1
                        ? 'Approve failed on-chain'
                        : `Batch ${closeDist.batchIndex + 1}/${closeDist.batches.length} failed on-chain`
                const hint =
                    closeDist.batchIndex === -1
                        ? ' Check you have enough $TOWNS and try again.'
                        : ' You can react 🚀 again to retry from approve.'
                await handler.sendMessage(
                    channelId,
                    `${step}. Airdrop not closed. [View tx](${txLink}).${hint}`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            
            // -1 = approve just done → go to 0; else next batch
            if (closeDist.batchIndex === -1) {
                closeDist.batchIndex = 0
            } else {
                closeDist.batchIndex += 1
            }
            
            if (closeDist.batchIndex >= closeDist.batches.length) {
                // All batches complete
                pendingCloseDistributes.delete(uid)
                reactionAirdrops.delete(closeDist.messageId)
                reactionAirdrops.delete(closeDist.threadId)
                await handler.sendMessage(
                    channelId,
                    `Airdrop closed. **${closeDist.recipients.length}** recipients received **${formatEther(closeDist.amountPer)} $TOWNS** each from your wallet.`,
                    { threadId, mentions: [{ userId: closeDist.creatorId, displayName: 'Creator' }] },
                )
                return
            }
            
            // Send next batch (transferFrom(creator, to, amount))
            const nextBatch = closeDist.batches[closeDist.batchIndex]!
            const data = encodeAggregate3TransferFrom(closeDist.creatorWallet, nextBatch, closeDist.amountPer)
            await handler.sendInteractionRequest(
                channelId,
                {
                    type: 'transaction',
                    id: `drop-close-batch-${Date.now()}-${closeDist.batchIndex}`,
                    title: 'Distribute $TOWNS (batch)',
                    subtitle: `Batch ${closeDist.batchIndex + 1}/${closeDist.batches.length} (${nextBatch.length} transfers)`,
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
                `Sign batch ${closeDist.batchIndex + 1}/${closeDist.batches.length} (${nextBatch.length} transfers, ${formatEther(closeDist.amountPer)} $TOWNS each)`,
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
        if (!tx.txHash) {
            // Transaction submitted but hash not yet available - the handler will be called again with the hash
            // Don't return early - wait for the next call with txHash
            return
        }
        let receipt: { status: string }
        try {
            receipt = await waitForTransactionReceipt(bot.viem, { hash: tx.txHash as `0x${string}` })
        } catch (e) {
            pendingDrops.delete(uid)
            const txLink = tx.txHash ? ` [View tx](https://basescan.org/tx/${tx.txHash})` : ''
            await handler.sendMessage(
                channelId,
                `Failed to verify transaction: ${e instanceof Error ? e.message : String(e)}.${txLink}`,
                { threadId },
            )
            return
        }
        if (receipt.status !== 'success') {
            pendingDrops.delete(uid)
            const txLink = `https://basescan.org/tx/${tx.txHash}`
            const batchIdx = pending.batchIndex ?? -1
            const step =
                batchIdx === -1
                    ? 'Approve failed on-chain'
                    : `Batch ${batchIdx + 1}/${(pending.batches ?? []).length} failed on-chain`
            const hint =
                batchIdx === -1
                    ? ' Check you have enough $TOWNS and try the flow again.'
                    : ' Run /drop again to retry from the start.'
            await handler.sendMessage(
                channelId,
                `${step}. [View tx](${txLink}).${hint}`,
                { threadId, mentions: [{ userId: pending.creatorId, displayName: 'Creator' }] },
            )
            return
        }

        // -1 = approve just done → go to 0; else next batch
        if (pending.batchIndex === -1) {
            pending.batchIndex = 0
        } else {
            pending.batchIndex = (pending.batchIndex ?? 0) + 1
        }
        const batches = pending.batches!
        const amountPer = pending.amountPer!
        
        if (pending.batchIndex >= batches.length) {
            // All batches complete
            pendingDrops.delete(uid)
            const n = pending.memberAddresses!.length
            await handler.sendMessage(
                channelId,
                `Airdrop done. **${n}** members received **${formatEther(amountPer)} $TOWNS** each from your wallet.`,
                { threadId },
            )
            return
        }
        
        // Send next batch (transferFrom(creator, to, amount))
        const nextBatch = batches[pending.batchIndex]!
        const data = encodeAggregate3TransferFrom(pending.creatorWallet!, nextBatch, amountPer)
        await handler.sendInteractionRequest(
            channelId,
            {
                type: 'transaction',
                id: `drop-fixed-batch-${Date.now()}-${pending.batchIndex}`,
                title: 'Distribute $TOWNS (batch)',
                subtitle: `Batch ${pending.batchIndex + 1}/${batches.length} (${nextBatch.length} transfers)`,
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
            `Sign batch ${pending.batchIndex + 1}/${batches.length} (${nextBatch.length} transfers, ${formatEther(amountPer)} $TOWNS each)`,
            { threadId, mentions: [{ userId, displayName: 'Creator' }] },
        )
    }
})

const app = bot.start()

app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

export default app
