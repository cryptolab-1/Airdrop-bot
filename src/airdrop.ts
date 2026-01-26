/**
 * Airdrop state and helpers for $TOWNS airdrops.
 * - Fixed: total amount split among all channel members.
 * - Reaction: airdrop active users who react 💸 (money with wings); total split between them.
 */

import type { Address } from 'viem'
import { parseEther, formatEther } from 'viem'
import { erc20Abi } from 'viem'
import { encodeFunctionData } from 'viem'
import { multicall3Abi } from 'viem'
import { getSmartAccountFromUserId, SnapshotGetter } from '@towns-protocol/bot'
import type { Bot, BotCommand } from '@towns-protocol/bot'

export type AnyBot = Bot<BotCommand[]>

export const TOWNS_ADDRESS = '0x00000000A22C618fd6b4D7E9A335C4B96B189a38' as const
/** Multicall3 on Base (same address on many chains). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
/**
 * Max transfers per multicall batch. Gas-safe limit; tune if needed.
 * ~65k gas per ERC20 transfer; Base block ~30M → ~400+ possible, we use 80.
 */
export const MAX_TRANSFERS_PER_BATCH = 80
/** Money with wings 💸 – react to join reaction airdrops. */
const JOIN_EMOJI = '💸'
const JOIN_SHORTCODES = [
    'money_with_wings',
    'moneywithwings',
    'money-with-wings',
    'dollar',
    'moneybag',
    'money_bag',
    'banknote',
    'dollar_banknote',
] as const

export type AirdropMode = 'fixed' | 'reaction'

export type PendingDrop = {
    mode: AirdropMode
    totalRaw: bigint
    channelId: string
    spaceId: string | null
    creatorId: Address
    creatorWallet?: Address
    memberAddresses?: Address[] // fixed mode: resolved smart accounts
    amountPer?: bigint
    /** Batches of recipients for multicall; one tx per batch. */
    batches?: Address[][]
    batchIndex?: number // Current batch index (0-based)
    /** Thread to post follow-ups in (avoid channel spam). */
    threadId?: string
}

export type ReactionAirdrop = {
    totalRaw: bigint
    creatorId: Address
    channelId: string
    reactorIds: Set<string>
    /** Airdrop message eventId. */
    airdropMessageId: string
    /** Thread root; all airdrop msgs live in this thread. */
    threadId: string
}

export type PendingCloseDistribute = {
    recipients: Address[]
    amountPer: bigint
    channelId: string
    messageId: string
    creatorId: Address
    creatorWallet: Address
    /** Batches of recipients for multicall; one tx per batch. */
    batches: Address[][]
    batchIndex: number // Current batch index (0-based)
    /** Thread to post close follow-ups in. */
    threadId: string
}

export const pendingDrops = new Map<Address, PendingDrop>()
export const reactionAirdrops = new Map<string, ReactionAirdrop>()
export const pendingCloseDistributes = new Map<Address, PendingCloseDistribute>()

/** Remove airdrop from map (indexed by airdrop message and thread root ids). */
export function deleteReactionAirdrop(airdrop: ReactionAirdrop): void {
    reactionAirdrops.delete(airdrop.airdropMessageId)
    reactionAirdrops.delete(airdrop.threadId)
}

/**
 * Find airdrop by messageId. Tries direct lookup, then checks all airdrops'
 * airdropMessageId, threadId (handles format mismatches).
 */
export function findReactionAirdrop(messageId: string): ReactionAirdrop | undefined {
    const direct = reactionAirdrops.get(messageId)
    if (direct) return direct
    const trimmed = messageId.trim()
    if (trimmed !== messageId) {
        const byTrim = reactionAirdrops.get(trimmed)
        if (byTrim) return byTrim
    }
    for (const a of reactionAirdrops.values()) {
        if (
            a.airdropMessageId === messageId ||
            a.threadId === messageId ||
            (trimmed && (a.airdropMessageId === trimmed || a.threadId === trimmed))
        )
            return a
    }
    return undefined
}

export function joinEmoji(): string {
    return JOIN_EMOJI
}

/** Match 💸 or shortcodes like "money_with_wings" (Towns may send either). */
export function isJoinReaction(r: string): boolean {
    if (r === JOIN_EMOJI) return true
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
    return JOIN_SHORTCODES.some((s) => n(r) === n(s))
}

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
function toUserId(m: unknown): string | null {
    if (typeof m === 'string' && ETH_ADDRESS_RE.test(m)) return m
    const o = m as { userId?: string } | null
    if (o && typeof o.userId === 'string' && ETH_ADDRESS_RE.test(o.userId)) return o.userId
    return null
}

/**
 * Extract userIds from space membership data. Use only the canonical membership map:
 * - If value has .memberships (map userId -> Membership), use those keys only.
 * - Else if value is that map (keys are userIds), use Object.keys.
 * - Else if value is an array of { userId } or 0x strings, use that.
 * Avoids treating display_names or other 0x-like fields as userIds.
 */
function parseMembershipsToUserIds(memberships: unknown): string[] {
    if (memberships && typeof memberships === 'object' && !Array.isArray(memberships)) {
        const obj = memberships as Record<string, unknown>
        const map = obj.memberships && typeof obj.memberships === 'object' && !Array.isArray(obj.memberships)
            ? (obj.memberships as Record<string, unknown>)
            : obj
        return Object.keys(map).filter((k) => ETH_ADDRESS_RE.test(k))
    }
    if (Array.isArray(memberships)) {
        return memberships.map(toUserId).filter((id): id is string => id != null)
    }
    return []
}

/**
 * Get space member user IDs via snapshot API.
 * Prefers bot.snapshot.getSpaceMemberships(spaceId) per Towns docs when available;
 * otherwise uses bot.client.getStream + SnapshotGetter.
 * Returns empty array if snapshot API is unavailable or fails.
 * Per docs: userId is the user's address (0x…). Snapshot data may be cached.
 */
export async function getSpaceMemberIds(bot: AnyBot, spaceId: string): Promise<string[]> {
    try {
        const snapshotApi = (bot as { snapshot?: { getSpaceMemberships?(id: string): Promise<unknown> } })
            .snapshot
        if (snapshotApi?.getSpaceMemberships) {
            const memberships = await snapshotApi.getSpaceMemberships(spaceId)
            return parseMembershipsToUserIds(memberships)
        }
        const client = (bot as { client?: { getStream?(streamId: string): Promise<unknown> } }).client
        const getStream = client?.getStream
        if (!getStream) return []
        const snapshot = SnapshotGetter(getStream as (streamId: string) => Promise<{ snapshot?: { content?: { case?: string; value?: Record<string, unknown> } } }>)
        const getSpaceMemberships = (snapshot as { getSpaceMemberships?(id: string): Promise<unknown> })
            .getSpaceMemberships
        if (!getSpaceMemberships) return []
        const memberships = await getSpaceMemberships(spaceId)
        return parseMembershipsToUserIds(memberships)
    } catch {
        return []
    }
}

/**
 * Get channel member user IDs via stream view (getMembers().joined).
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
 * Resolve user IDs to wallet addresses. Uses linked smart account when available,
 * otherwise falls back to userId (Towns wallet address).
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
        out.push((addr ?? (uid as Address)))
    }
    return out
}

/**
 * Return only Towns wallet addresses when the same person appears as both
 * Towns wallet and linked smart account. getSmartAccountFromUserId(wallet) returns
 * the smart account; we keep the wallet and drop the smart account when both are
 * in the list so each person receives once at their Towns wallet.
 */
export async function uniqueTownsWallets(
    bot: AnyBot,
    userIds: string[]
): Promise<Address[]> {
    if (userIds.length === 0) return []
    const resolved = new Map<string, string>()
    for (const uid of userIds) {
        const addr = await getSmartAccountFromUserId(bot as Bot<BotCommand[]>, {
            userId: uid as Address,
        })
        resolved.set(uid.toLowerCase(), ((addr ?? uid) as string).toLowerCase())
    }
    const out: Address[] = []
    for (const uid of userIds) {
        const u = uid.toLowerCase()
        const isSmartAccountOfAnother = [...resolved.entries()].some(
            ([id, val]) => id !== u && val === u
        )
        if (!isSmartAccountOfAnother) out.push(uid as Address)
    }
    return out
}

/**
 * For fixed drops: get channel/space member userIds, resolve each to wallet via
 * getSmartAccountFromUserId, exclude the bot (and any extra addresses), and dedupe
 * by final wallet address so each person receives exactly once.
 * @param excludeAddresses - Optional list of addresses to exclude (e.g. other bots in the chat)
 * @param onlyResolved - If true (default), only include userIds that resolve to a Towns wallet
 *   via getSmartAccountFromUserId. Skips ids that return null (e.g. "hex from name" in memberships).
 */
export async function getUniqueRecipientAddresses(
    bot: AnyBot,
    userIds: string[],
    opts?: { excludeAddresses?: string[]; onlyResolved?: boolean }
): Promise<Address[]> {
    const onlyResolved = opts?.onlyResolved !== false
    const botApp = ((bot as { appAddress?: string }).appAddress ?? '').toLowerCase()
    const botId = ((bot as { botId?: string }).botId ?? '').toLowerCase()
    const extra = new Set(
        (opts?.excludeAddresses ?? [])
            .map((a) => a.trim().toLowerCase())
            .filter((a) => /^0x[a-f0-9]{40}$/.test(a))
    )
    const seen = new Set<string>()
    const out: Address[] = []
    for (const uid of userIds) {
        const w = uid.toLowerCase()
        if (w === botApp || w === botId || extra.has(w)) continue
        const addr = await getSmartAccountFromUserId(bot as Bot<BotCommand[]>, {
            userId: uid as Address,
        })
        if (onlyResolved && addr == null) continue
        const wallet = ((addr ?? uid) as string).toLowerCase()
        if (seen.has(wallet) || extra.has(wallet)) continue
        seen.add(wallet)
        out.push((addr ?? (uid as Address)) as Address)
    }
    return out
}

/**
 * Encode ERC20 transfer(to, amount). Direct transfer from sender's wallet.
 */
export function encodeTransfer(to: Address, amountRaw: bigint): `0x${string}` {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amountRaw],
    })
}

/**
 * Encode ERC20 approve(spender, amount). Creator approves Multicall3 so it can transferFrom.
 */
export function encodeApprove(spender: Address, amountRaw: bigint): `0x${string}` {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amountRaw],
    })
}

/**
 * Encode ERC20 transferFrom(from, to, amount). Multicall3 calls this; from must have approved Multicall3.
 */
export function encodeTransferFrom(
    from: Address,
    to: Address,
    amountRaw: bigint
): `0x${string}` {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [from, to, amountRaw],
    })
}

/**
 * Chunk recipients into batches of at most MAX_TRANSFERS_PER_BATCH.
 */
export function chunkRecipients(recipients: Address[]): Address[][] {
    const out: Address[][] = []
    for (let i = 0; i < recipients.length; i += MAX_TRANSFERS_PER_BATCH) {
        out.push(recipients.slice(i, i + MAX_TRANSFERS_PER_BATCH))
    }
    return out
}

/** Build Multicall3 aggregate3 calls for transferFrom(creator, to, amountPer). */
export function buildAggregate3TransferFromCalls(
    creator: Address,
    recipients: Address[],
    amountPer: bigint
): Array<{ target: Address; allowFailure: false; callData: `0x${string}` }> {
    return recipients.map((to) => ({
        target: TOWNS_ADDRESS as Address,
        allowFailure: false as const,
        callData: encodeTransferFrom(creator, to, amountPer),
    }))
}

/**
 * Encode Multicall3 aggregate3(calls) for a batch of transferFrom(creator, recipient, amountPer).
 * Creator must have approved MULTICALL3_ADDRESS for the total amount.
 */
export function encodeAggregate3TransferFrom(
    creator: Address,
    recipients: Address[],
    amountPer: bigint
): `0x${string}` {
    const calls = buildAggregate3TransferFromCalls(creator, recipients, amountPer)
    return encodeFunctionData({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        args: [calls],
    })
}

/**
 * Encode one Multicall3 call that does approve(Multicall3, totalRaw) then transferFrom(creator, to, amountPer) for each recipient in firstBatch.
 * Used as the first user tx so the client never sees a standalone "approve" that it might render as "send tokens".
 * Target is MULTICALL3_ADDRESS; calldata is aggregate3([approve, ...transferFroms]).
 */
export function encodeAggregate3ApproveAndFirstBatch(
    creator: Address,
    totalRaw: bigint,
    firstBatch: Address[],
    amountPer: bigint
): `0x${string}` {
    const approveCall = {
        target: TOWNS_ADDRESS as Address,
        allowFailure: false as const,
        callData: encodeApprove(MULTICALL3_ADDRESS as Address, totalRaw),
    }
    const transferCalls = buildAggregate3TransferFromCalls(creator, firstBatch, amountPer)
    return encodeFunctionData({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        args: [[approveCall, ...transferCalls]],
    })
}

export { parseEther, formatEther }
