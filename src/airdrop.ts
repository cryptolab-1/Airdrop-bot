/**
 * Airdrop state and helpers for $TOWNS airdrops.
 * - Fixed: airdrop every channel member a fixed amount.
 * - Reaction: airdrop active users who react 🤭; total split between them.
 */

import type { Address } from 'viem'
import { parseEther, formatEther } from 'viem'
import { erc20Abi } from 'viem'
import { encodeFunctionData } from 'viem'
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
    /** Fixed-mode distribution: user signs each transfer. */
    distributeRecipients?: Address[]
    distributeIndex?: number
}

export type ReactionAirdrop = {
    totalRaw: bigint
    creatorId: Address
    channelId: string
    reactorIds: Set<string>
}

export type PendingCloseDistribute = {
    recipients: Address[]
    amountPer: bigint
    channelId: string
    messageId: string
    creatorId: Address
    index: number
}

export const pendingDrops = new Map<Address, PendingDrop>()
export const reactionAirdrops = new Map<string, ReactionAirdrop>()
export const pendingCloseDistributes = new Map<Address, PendingCloseDistribute>()

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
 * Encode ERC20 transfer(recipient, amount) for creator to send from their wallet.
 */
export function encodeTransfer(recipient: Address, amountRaw: bigint): `0x${string}` {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, amountRaw],
    })
}

export { parseEther, formatEther }
