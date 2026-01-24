/**
 * Airdrop state and helpers for $TOWNS airdrops.
 * - Fixed: airdrop every channel member a fixed amount.
 * - Reaction: airdrop active users who react 🤭; total split between them.
 */

import type { Address } from 'viem'
import { parseEther, formatEther } from 'viem'
import { erc20Abi } from 'viem'
import { encodeFunctionData } from 'viem'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt } from 'viem/actions'
import { getSmartAccountFromUserId } from '@towns-protocol/bot'
import type { Bot, BotCommand } from '@towns-protocol/bot'

export type AnyBot = Bot<BotCommand[]>

export const TOWNS_ADDRESS = '0x00000000A22C618fd6b4D7E9A335C4B96B189a38' as const
const MONEY_MOUTH = '🤭'

export type AirdropMode = 'fixed' | 'reaction'

export type PendingDrop = {
    mode: AirdropMode
    totalRaw: bigint
    channelId: string
    spaceId: string | null
    creatorId: Address
    creatorWallet?: Address
    memberAddresses?: Address[] // fixed mode: resolved smart accounts
}

export type ReactionAirdrop = {
    totalRaw: bigint
    creatorId: Address
    channelId: string
    reactorIds: Set<string>
}

export const pendingDrops = new Map<Address, PendingDrop>()
export const reactionAirdrops = new Map<string, ReactionAirdrop>()

export function moneyMouthEmoji(): string {
    return MONEY_MOUTH
}

export function isMoneyMouth(r: string): boolean {
    return r === MONEY_MOUTH
}

/**
 * Get channel member user IDs via stream view.
 * Returns empty array if unavailable.
 */
export async function getChannelMemberIds(
    bot: AnyBot,
    channelId: string
): Promise<string[]> {
    try {
        const view = await bot.getStreamView(channelId)
        const members = (view as { getMembers?: () => { joined?: Map<string, unknown> } })
            ?.getMembers?.()
            ?.joined
        if (!members || typeof members.keys !== 'function') return []
        return Array.from(members.keys())
    } catch {
        return []
    }
}

/**
 * Resolve user IDs to smart accounts; skip nulls.
 */
export async function resolveMemberAddresses(
    bot: AnyBot,
    userIds: string[]
): Promise<Address[]> {
    const out: Address[] = []
    for (const uid of userIds) {
        const addr = await getSmartAccountFromUserId(bot as Bot<BotCommand[]>, {
            userId: uid as Address,
        })
        if (addr) out.push(addr)
    }
    return out
}

/**
 * Distribute TOWNS from creator's wallet to recipients via transferFrom.
 * Creator must have approved bot.appAddress for totalRaw.
 */
export async function distributeFromCreator(
    bot: AnyBot,
    creatorWallet: Address,
    recipients: Address[],
    totalRaw: bigint,
    _mode: AirdropMode
): Promise<void> {
    if (recipients.length === 0) return
    const amountPer = totalRaw / BigInt(recipients.length)
    const calls = recipients.map((to) => ({
        to: TOWNS_ADDRESS as Address,
        abi: erc20Abi,
        functionName: 'transferFrom' as const,
        args: [creatorWallet, to, amountPer] as [Address, Address, bigint],
    }))
    const hash = await execute(bot.viem, {
        address: bot.appAddress,
        account: bot.viem.account,
        calls,
    })
    await waitForTransactionReceipt(bot.viem, { hash })
}

/**
 * Encode ERC20 approve(spender, amount) for creator to approve bot.
 */
export function encodeApprove(
    spender: Address,
    amountRaw: bigint
): `0x${string}` {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amountRaw],
    })
}

export { parseEther, formatEther }
