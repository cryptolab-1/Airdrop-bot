/**
 * $TOWNS Airdrop Bot
 *
 * /drop  – Opens the miniapp UI for creating & managing airdrops.
 * /help  – Shows available commands.
 *
 * Architecture mirrors the working Towns miniapp pattern:
 *   • Single static HTML in public/miniapp.html
 *   • Served via readFileSync + Hono route
 *   • export default app
 */

import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import type { Bot, BotCommand } from '@towns-protocol/bot'
import { erc20Abi, encodeFunctionData } from 'viem'
import type { Address } from 'viem'
import { readContract, waitForTransactionReceipt, multicall } from 'viem/actions'
import { execute as executeErc7821 } from 'viem/experimental/erc7821'
import { supportsExecutionMode } from 'viem/experimental/erc7821'
import { parseEther, formatEther, parseAbi, parseAbiItem } from 'viem'
import { getLogs, getBlockNumber } from 'viem/actions'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import commands from './commands'
import {
    initDb,
    saveAirdrop,
    getAirdrop,
    updateAirdrop,
    listPublicAirdrops,
    listAirdropsByCreator,
    listAirdropHistory,
    getAirdropCount,
    setParticipantName,
    getParticipantName,
    getParticipantNames,
    saveTaxHolders,
    getTaxHolders,
    getTaxHolderCount,
    getTaxHoldersLastUpdated,
    saveSpaceHolders,
    getSpaceHolders,
    getSpaceHoldersLastUpdated,
    isSpaceHoldersStale,
    saveTokenInfo,
    getTokenInfo,
    getTopRecipients,
    getTopCreators,
    getTopSpaces,
    saveSpaceName,
    getSpaceName,
    setUserWallet,
    getUserWallet,
    getUserIdsByWallets,
    deleteAirdrop,
    resetLeaderboard,
    deleteHistoryAirdrops,
} from './db'
import type { Airdrop, AirdropStatus } from './db'

// ============================================================================
// Constants
// ============================================================================

const TOWNS_ADDRESS = '0x00000000A22C618fd6b4D7E9A335C4B96B189a38' as const
const MAX_TRANSFERS_PER_BATCH = 80
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

const ERC721_HOLDERS_ABI = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
])

const ERC721_TRANSFER = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
)
const ERC721A_CONSECUTIVE = parseAbiItem(
    'event ConsecutiveTransfer(uint256 indexed fromTokenId, uint256 toTokenId, address indexed from, address indexed to)',
)

const OWNEROF_BATCH_SIZE = 256
const DEFAULT_NFT_TIMEOUT_MS = 30_000
const DEFAULT_NFT_RETRIES = 3
const DEFAULT_NFT_RETRY_DELAY_MS = 3_000
const DISTRIBUTION_RETRIES = Math.max(
    1,
    Math.min(10, parseInt(process.env.AIRDROP_DISTRIBUTION_RETRIES ?? '4', 10) || 4),
)
const DISTRIBUTION_RETRY_DELAY_MS = Math.max(
    500,
    parseInt(process.env.AIRDROP_DISTRIBUTION_RETRY_DELAY_MS ?? '2000', 10) || 2000,
)

// Tax system: holder tax + admin tax
// Holder tax: distributed to NFT holders of the tax NFT contract
const AIRDROP_TAX_PERCENT = Math.max(
    0,
    Math.min(100, parseFloat(process.env.AIRDROP_TAX_PERCENT ?? '2')),
)
const AIRDROP_TAX_NFT_ADDRESS = (process.env.AIRDROP_TAX_NFT_ADDRESS ?? '').trim()

// Admin tax: sent to the bot admin wallet
const AIRDROP_ADMIN_TAX_PERCENT = Math.max(
    0,
    Math.min(100, parseFloat(process.env.AIRDROP_ADMIN_TAX_PERCENT ?? '1')),
)
const BOT_ADMIN_ADDRESS = (process.env.BOT_ADMIN_ADDRESS ?? '').trim()
const ADMIN_RIGHTS = (process.env.ADMIN_RIGHTS ?? '').trim()

// ============================================================================
// Bot initialization
// ============================================================================

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

console.log(`[Bot] Gas wallet: ${bot.viem.account.address}`)
console.log(`[Bot] Treasury:   ${bot.appAddress}`)

// Initialise persistent SQLite database
initDb()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MINIAPP_URL = process.env.MINIAPP_URL || `${process.env.BASE_URL}/miniapp.html`

// ============================================================================
// Types
// ============================================================================

type AnyBot = Bot<BotCommand[]>

// Types are now imported from ./db

// ============================================================================
// Helpers (NFT holders, distribution, utils)
// ============================================================================

function sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error('NFT fetch timeout')), ms)),
    ])
}

function isEthAddress(s: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(s)
}

/** Check if a userId is the admin (matches ADMIN_RIGHTS env var) */
function isAdminUser(userId: string): boolean {
    if (!ADMIN_RIGHTS || !isEthAddress(ADMIN_RIGHTS)) return false
    return userId.toLowerCase() === ADMIN_RIGHTS.toLowerCase()
}

/**
 * Extract the Ethereum address from a Towns stream ID.
 * Towns encodes spaceId/channelId as: type-prefix(1 byte) + address(20 bytes) + padding.
 * E.g. spaceId "106ffe907dceb3a7766a8dbb374a6ffe8ad3c0b50b0000000000000000000000"
 *   → "0x6ffe907dceb3a7766a8dbb374a6ffe8ad3c0b50b"
 * If already a valid 0x address, returns as-is.
 */
function extractAddressFromStreamId(streamId: string): string | null {
    if (!streamId) return null
    // Already a valid Ethereum address
    if (isEthAddress(streamId)) return streamId
    // Strip 0x prefix if present
    const hex = streamId.startsWith('0x') ? streamId.slice(2) : streamId
    // Encoded format: 2-char type prefix + 40-char address + padding
    if (hex.length >= 42) {
        const candidate = '0x' + hex.slice(2, 42)
        if (isEthAddress(candidate)) return candidate
    }
    return null
}

function generateId(): string {
    return `airdrop_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** Calculate holder tax, admin tax, and net amounts from a gross total. */
function computeTax(totalWei: bigint): {
    holderTaxAmount: bigint
    adminTaxAmount: bigint
    netAmount: bigint
} {
    // Use basis points for precision (2% = 200 bps, 1% = 100 bps)
    const holderBps = BigInt(Math.round(AIRDROP_TAX_PERCENT * 100))
    const adminBps = BigInt(Math.round(AIRDROP_ADMIN_TAX_PERCENT * 100))
    const holderTaxAmount = (totalWei * holderBps) / 10000n
    const adminTaxAmount = isEthAddress(BOT_ADMIN_ADDRESS)
        ? (totalWei * adminBps) / 10000n
        : 0n
    const netAmount = totalWei - holderTaxAmount - adminTaxAmount
    return { holderTaxAmount, adminTaxAmount, netAmount }
}

function airdropToResponse(a: Airdrop) {
    const namesMap = getParticipantNames([a.creatorAddress, ...a.participants])
    const spaceName = a.spaceNftAddress ? getSpaceName(a.spaceNftAddress) : null
    return {
        id: a.id,
        creatorAddress: a.creatorAddress,
        creatorName: namesMap.get(a.creatorAddress.toLowerCase()) || null,
        airdropType: a.airdropType,
        spaceNftAddress: a.spaceNftAddress || null,
        spaceName,
        currency: a.currency,
        currencySymbol: a.currencySymbol,
        currencyDecimals: a.currencyDecimals,
        totalAmount: a.totalAmount,
        taxPercent: a.taxPercent,
        taxAmount: a.taxAmount,
        adminTaxPercent: a.adminTaxPercent,
        adminTaxAmount: a.adminTaxAmount,
        netAmount: a.netAmount,
        amountPerRecipient: a.amountPerRecipient,
        recipientCount: a.recipientCount,
        status: a.status,
        participants: a.participants,
        participantNames: Object.fromEntries(
            a.participants.map(p => [p, namesMap.get(p.toLowerCase()) || null])
        ),
        taxHolderCount: a.taxHolders.length > 0 ? a.taxHolders.length : getTaxHolderCount(),
        txHash: a.distributionTxHash || a.depositTxHash,
        title: a.title || null,
        description: a.description || null,
        maxParticipants: a.maxParticipants || 0,
        createdAt: a.createdAt,
        isSpaceJoinMode: a.airdropType === 'space' && (a.maxParticipants || 0) > 0,
        mode: (a.airdropType === 'space' && (a.maxParticipants || 0) === 0) ? 'fixed' : 'react', // backward compat
    }
}

function chunkRecipients(recipients: Address[]): Address[][] {
    const out: Address[][] = []
    for (let i = 0; i < recipients.length; i += MAX_TRANSFERS_PER_BATCH) {
        out.push(recipients.slice(i, i + MAX_TRANSFERS_PER_BATCH))
    }
    return out
}

// ---- NFT holder fetching ---------------------------------------------------

async function getMembershipNftHolderAddresses(
    b: AnyBot,
    nftContractAddress: Address,
): Promise<Address[]> {
    const viem = (b as any).viem
    if (!viem) return []

    const timeoutMs = Math.max(
        5000,
        parseInt(process.env.AIRDROP_NFT_TIMEOUT_MS ?? String(DEFAULT_NFT_TIMEOUT_MS), 10) ||
            DEFAULT_NFT_TIMEOUT_MS,
    )
    const retries = Math.max(
        1,
        Math.min(
            10,
            parseInt(process.env.AIRDROP_NFT_RETRIES ?? String(DEFAULT_NFT_RETRIES), 10) ||
                DEFAULT_NFT_RETRIES,
        ),
    )
    const retryDelayMs = Math.max(
        500,
        parseInt(
            process.env.AIRDROP_NFT_RETRY_DELAY_MS ?? String(DEFAULT_NFT_RETRY_DELAY_MS),
            10,
        ) || DEFAULT_NFT_RETRY_DELAY_MS,
    )

    const doFetch = async (): Promise<Address[]> => {
        const total = await readContract(viem, {
            address: nftContractAddress,
            abi: ERC721_HOLDERS_ABI,
            functionName: 'totalSupply',
        })
        if (total === 0n) return []

        const holders = new Set<string>()
        for (const base of [1n, 0n]) {
            const last = base === 1n ? total : total - 1n
            if (last < base) continue
            for (let start = base; start <= last; start += BigInt(OWNEROF_BATCH_SIZE)) {
                const end =
                    start + BigInt(OWNEROF_BATCH_SIZE) - 1n > last
                        ? last
                        : start + BigInt(OWNEROF_BATCH_SIZE) - 1n
                const contracts = []
                for (let id = start; id <= end; id++) {
                    contracts.push({
                        address: nftContractAddress,
                        abi: ERC721_HOLDERS_ABI,
                        functionName: 'ownerOf' as const,
                        args: [id],
                    })
                }
                const results = await multicall(viem, { contracts, allowFailure: true })
                for (const r of results) {
                    if (
                        r.status === 'success' &&
                        r.result &&
                        (r.result as string).toLowerCase() !== ZERO_ADDRESS.toLowerCase()
                    )
                        holders.add((r.result as string).toLowerCase() as Address)
                }
            }
            if (holders.size > 0) break
        }
        return [...holders] as Address[]
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await withTimeout(doFetch(), timeoutMs)
            if (result.length > 0) return result
        } catch {
            // continue to retry or fallback
        }
        if (attempt < retries - 1) await sleepMs(retryDelayMs)
    }
    return getMembershipNftHolderAddressesFromEvents(bot, nftContractAddress)
}

/** Strip common suffixes like " - Member" from space names */
function cleanSpaceName(raw: string): string {
    return raw.replace(/\s*-\s*Member(ship)?$/i, '').trim()
}

/** Fetch the space name from the ERC721 contract, with DB caching. */
async function fetchSpaceName(nftAddress: string): Promise<string> {
    // Check DB cache first
    const cached = getSpaceName(nftAddress)
    if (cached) {
        const cleaned = cleanSpaceName(cached)
        // Update cache if the name was cleaned
        if (cleaned !== cached) saveSpaceName(nftAddress, cleaned)
        return cleaned
    }

    // Fetch from chain
    const viem = (bot as any).viem
    if (!viem) return ''
    try {
        const name = await readContract(viem, {
            address: nftAddress as Address,
            abi: ERC721_HOLDERS_ABI,
            functionName: 'name',
        }) as string
        // Strip common suffixes like " - Member", " - Membership", etc.
        const cleaned = name ? name.replace(/\s*-\s*Member(ship)?$/i, '').trim() : ''
        if (cleaned) {
            saveSpaceName(nftAddress, cleaned)
            console.log(`[SpaceName] Cached name "${cleaned}" for ${nftAddress}`)
        }
        return cleaned
    } catch (err) {
        console.warn(`[SpaceName] Failed to fetch name for ${nftAddress}:`, err)
        return ''
    }
}

async function getMembershipNftHolderAddressesFromEvents(
    b: AnyBot,
    spaceContractAddress: Address,
): Promise<Address[]> {
    const viem = (b as any).viem
    if (!viem) return []
    try {
        const toBlock = await getBlockNumber(viem)
        const chunk = 5_000n
        const tokenToOwner = new Map<string, string>()
        for (let from = 0n; from <= toBlock; from += chunk) {
            const to = from + chunk > toBlock ? toBlock : from + chunk - 1n
            const [transferLogs, consecutiveLogs] = await Promise.all([
                getLogs(viem, {
                    address: spaceContractAddress,
                    event: ERC721_TRANSFER,
                    fromBlock: from,
                    toBlock: to,
                }),
                getLogs(viem, {
                    address: spaceContractAddress,
                    event: ERC721A_CONSECUTIVE,
                    fromBlock: from,
                    toBlock: to,
                }),
            ])
            for (const log of transferLogs) {
                const tokenId = log.args?.tokenId
                const toAddr = log.args?.to
                if (
                    tokenId != null &&
                    toAddr &&
                    (toAddr as string).toLowerCase() !== ZERO_ADDRESS.toLowerCase()
                )
                    tokenToOwner.set(String(tokenId), (toAddr as string).toLowerCase())
            }
            for (const log of consecutiveLogs) {
                const fromId =
                    log.args?.fromTokenId != null ? BigInt(log.args.fromTokenId as bigint) : null
                const toId =
                    log.args?.toTokenId != null ? BigInt(log.args.toTokenId as bigint) : null
                const toAddr = log.args?.to
                if (
                    fromId == null ||
                    toId == null ||
                    !toAddr ||
                    (toAddr as string).toLowerCase() === ZERO_ADDRESS.toLowerCase()
                )
                    continue
                const toStr = (toAddr as string).toLowerCase()
                for (let id = fromId; id <= toId; id++) tokenToOwner.set(String(id), toStr)
            }
        }
        return [...new Set(tokenToOwner.values())].map((a) => a as Address)
    } catch {
        return []
    }
}

async function getUniqueRecipientAddresses(
    b: AnyBot,
    userIds: string[],
    opts?: { excludeAddresses?: string[]; onlyResolved?: boolean },
): Promise<Address[]> {
    const onlyResolved = opts?.onlyResolved !== false
    const botApp = ((b as any).appAddress ?? '').toLowerCase()
    const botId = ((b as any).botId ?? '').toLowerCase()
    const extra = new Set(
        (opts?.excludeAddresses ?? [])
            .map((a) => a.trim().toLowerCase())
            .filter((a) => /^0x[a-f0-9]{40}$/.test(a)),
    )
    const seen = new Set<string>()
    const out: Address[] = []
    for (const uid of userIds) {
        const w = uid.toLowerCase()
        if (w === botApp || w === botId || extra.has(w)) continue
        const addr = await getSmartAccountFromUserId(b as Bot<BotCommand[]>, {
            userId: uid as Address,
        })
        if (onlyResolved && addr == null) continue
        const wallet = ((addr ?? uid) as string).toLowerCase()
        if (seen.has(wallet) || extra.has(wallet)) continue
        seen.add(wallet)
        out.push((addr ?? (uid as Address)) as Address)
        // Store userId (EOA) → smart wallet mapping for later name resolution
        if (addr && isEthAddress(uid)) {
            setUserWallet(uid, wallet)
        }
    }
    return out
}

// ---- Distribution ----------------------------------------------------------

async function runBotDistribution(
    recipients: Address[],
    amountPer: bigint,
    _totalRaw: bigint,
    fromAddress: Address,
    tokenAddress: Address = TOWNS_ADDRESS as Address,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
    const treasury = bot.appAddress as Address | undefined
    const account = (bot.viem as any).account
    if (!treasury || fromAddress.toLowerCase() !== treasury.toLowerCase() || !account) {
        return { ok: false, error: 'Distribution only supported from bot treasury.' }
    }
    const batches = chunkRecipients(recipients)
    let lastHash: string | undefined

    for (let attempt = 0; attempt < DISTRIBUTION_RETRIES; attempt++) {
        try {
            const ok = await supportsExecutionMode(bot.viem, { address: treasury })
            if (!ok) {
                if (attempt < DISTRIBUTION_RETRIES - 1) {
                    await sleepMs(DISTRIBUTION_RETRY_DELAY_MS)
                    continue
                }
                return { ok: false, error: 'Treasury does not support ERC-7821 execute().' }
            }
            for (const batch of batches) {
                const hash = await executeErc7821(bot.viem, {
                    address: treasury,
                    account: account as any,
                    calls: batch.map((to) => ({
                        to: tokenAddress,
                        abi: erc20Abi,
                        functionName: 'transfer',
                        args: [to, amountPer],
                    })),
                })
                lastHash = hash as string
                await waitForTransactionReceipt(bot.viem, { hash: hash as `0x${string}` })
            }
            return { ok: true, txHash: lastHash }
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            if (attempt < DISTRIBUTION_RETRIES - 1) {
                await sleepMs(DISTRIBUTION_RETRY_DELAY_MS)
                continue
            }
            return { ok: false, error: err }
        }
    }
    return { ok: false, error: 'Treasury does not support ERC-7821 execute().' }
}

async function runDistribution(airdrop: Airdrop) {
    const botAddress = bot.appAddress as Address
    const amountPer = BigInt(airdrop.amountPerRecipient)
    const netRaw = BigInt(airdrop.netAmount)
    const recipients = airdrop.participants.map((a) => a as Address)
    const tokenAddress = (airdrop.currency || TOWNS_ADDRESS) as Address

    // 1. Distribute net amount to airdrop recipients
    const result = await runBotDistribution(recipients, amountPer, netRaw, botAddress, tokenAddress)

    if (!result.ok) {
        console.error('[Distribution] Main distribution failed:', result.error)
        updateAirdrop(airdrop.id, { status: 'funded', updatedAt: Date.now() })
        return
    }

    updateAirdrop(airdrop.id, { distributionTxHash: result.txHash, updatedAt: Date.now() })

    // 2. Distribute holder tax to town members (NFT holders)
    const holderTaxAmount = BigInt(airdrop.taxAmount)
    const taxHolderList = airdrop.taxHolders.length > 0 ? airdrop.taxHolders : getTaxHolders()
    if (holderTaxAmount > 0n && taxHolderList.length > 0) {
        try {
            const taxRecipients = taxHolderList.map((a) => a as Address)
            const source = airdrop.taxHolders.length > 0 ? 'pre-fetched' : 'database'
            console.log(`[Tax] Distributing ${holderTaxAmount} holder tax to ${taxRecipients.length} ${source} town members`)

            const taxPerMember = holderTaxAmount / BigInt(taxRecipients.length)
            if (taxPerMember > 0n) {
                const taxResult = await runBotDistribution(
                    taxRecipients,
                    taxPerMember,
                    holderTaxAmount,
                    botAddress,
                    tokenAddress,
                )
                if (taxResult.ok) {
                    updateAirdrop(airdrop.id, { taxDistributionTxHash: taxResult.txHash, updatedAt: Date.now() })
                    console.log(`[Tax] Holder tax distributed to ${taxRecipients.length} town members (tx: ${taxResult.txHash})`)
                } else {
                    console.error('[Tax] Holder tax distribution failed:', taxResult.error)
                }
            }
        } catch (err) {
            console.error('[Tax] Error during holder tax distribution:', err)
        }
    } else if (holderTaxAmount > 0n) {
        console.warn('[Tax] No tax holders available, skipping holder tax distribution')
    }

    // 3. Distribute admin tax to bot admin wallet
    const adminTaxAmount = BigInt(airdrop.adminTaxAmount)
    if (adminTaxAmount > 0n && isEthAddress(BOT_ADMIN_ADDRESS)) {
        try {
            console.log(`[Tax] Sending ${adminTaxAmount} admin tax to ${BOT_ADMIN_ADDRESS}`)
            const adminResult = await runBotDistribution(
                [BOT_ADMIN_ADDRESS as Address],
                adminTaxAmount,
                adminTaxAmount,
                botAddress,
                tokenAddress,
            )
            if (adminResult.ok) {
                updateAirdrop(airdrop.id, { adminTaxDistributionTxHash: adminResult.txHash, updatedAt: Date.now() })
                console.log(`[Tax] Admin tax sent (tx: ${adminResult.txHash})`)
            } else {
                console.error('[Tax] Admin tax distribution failed:', adminResult.error)
            }
        } catch (err) {
            console.error('[Tax] Error during admin tax distribution:', err)
        }
    }

    updateAirdrop(airdrop.id, { status: 'completed', updatedAt: Date.now() })
}

// ============================================================================
// Slash Commands
// ============================================================================

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**$TOWNS Airdrop Bot**\n\n' +
            '• `/drop` - Open the airdrop mini app\n' +
            '• `/help` - Show this help\n\n' +
            'The mini app provides a visual interface for creating and managing airdrops.',
    )
})

bot.onSlashCommand('drop', async (handler, event) => {
    const { channelId, isDm } = event

    if (isDm) {
        await handler.sendMessage(channelId, 'Use `/drop` in a space channel.')
        return
    }

    // Pass the spaceId in the miniapp URL so the miniapp knows which space to airdrop
    const spaceId = !isDm ? event.spaceId : null
    const spaceAddress = spaceId ? extractAddressFromStreamId(spaceId) : null
    const url = spaceAddress
        ? `${MINIAPP_URL}${MINIAPP_URL.includes('?') ? '&' : '?'}spaceId=${spaceAddress}`
        : MINIAPP_URL

    console.log(`[Drop] spaceId=${spaceId}, extracted=${spaceAddress}, url=${url}`)

    await handler.sendMessage(channelId, '', {
        attachments: [
            {
                type: 'miniapp',
                url,
            },
        ],
    })
})

// ============================================================================
// Interaction Response Handler (for deposit transactions)
// ============================================================================

bot.onInteractionResponse(async (handler, event) => {
    try {
        const content = (event.response as any)?.payload?.content

        // Log for debugging
        console.log('[InteractionResponse] Received:', JSON.stringify({
            channelId: event.channelId,
            userId: event.userId,
            contentCase: content?.case,
        }))

        // Only handle transaction responses
        if (content?.case !== 'transaction') return

        const tx = content.value
        const requestId: string | undefined = tx?.requestId || tx?.id
        const txHash: string | undefined = tx?.txHash || tx?.transactionHash || tx?.hash

        console.log('[InteractionResponse] Transaction: requestId=', requestId, 'txHash=', txHash, 'error=', tx?.error)

        // Match deposit requests by their ID prefix "deposit-"
        if (!requestId || !requestId.startsWith('deposit-')) return

        if (tx?.error) {
            console.warn('[InteractionResponse] Transaction rejected:', tx.error)
            return
        }

        if (!txHash) {
            console.warn('[InteractionResponse] No tx hash in response for', requestId)
            return
        }

        const airdropId = requestId.replace('deposit-', '')
        const airdrop = getAirdrop(airdropId)
        if (!airdrop) {
            console.warn('[InteractionResponse] Airdrop not found:', airdropId)
            return
        }

        if (airdrop.status !== 'pending') {
            console.log('[InteractionResponse] Airdrop already processed:', airdropId, airdrop.status)
            return
        }

        // Verify the transaction on-chain
        console.log('[InteractionResponse] Verifying tx on-chain:', txHash)
        const receipt = await waitForTransactionReceipt(bot.viem, {
            hash: txHash as `0x${string}`,
        })

        if (receipt.status !== 'success') {
            console.error('[InteractionResponse] Transaction failed on-chain:', txHash)
            await handler.sendMessage(event.channelId, 'Deposit transaction failed on-chain. Please try again.')
            return
        }

        // Mark as funded
        updateAirdrop(airdropId, { depositTxHash: txHash, status: 'funded', updatedAt: Date.now() })
        console.log('[InteractionResponse] Deposit confirmed for', airdropId)

        // Remove the deposit interaction request from chat
        if (airdrop.depositInteractionEventId && airdrop.depositChannelId) {
            try {
                await handler.removeEvent(airdrop.depositChannelId, airdrop.depositInteractionEventId)
                console.log('[InteractionResponse] Removed deposit interaction from chat')
            } catch (err) {
                console.warn('[InteractionResponse] Failed to remove deposit interaction:', err)
            }
        }

        // Space airdrops: auto-distribute if all-holders mode, or wait for joins if join mode
        const isJoinableSpace = airdrop.airdropType === 'space' && (airdrop.maxParticipants || 0) > 0
        if (airdrop.airdropType === 'space' && !isJoinableSpace && airdrop.participants.length > 0) {
            updateAirdrop(airdropId, { status: 'distributing', updatedAt: Date.now() })
            await handler.sendMessage(event.channelId, `Deposit confirmed! Distributing to ${airdrop.participants.length} recipients...`)
            // Re-read the latest state for distribution
            const fresh = getAirdrop(airdropId)
            if (fresh) runDistribution(fresh).catch(console.error)
        } else if (isJoinableSpace) {
            await handler.sendMessage(event.channelId, `Deposit confirmed! Your space airdrop is now live — space members can join (${airdrop.maxParticipants} slots).`)
        } else if (airdrop.airdropType === 'public') {
            await handler.sendMessage(event.channelId, 'Deposit confirmed! Your public airdrop is now live.')
        }
    } catch (err) {
        console.error('[InteractionResponse] Error:', err)
    }
})

// ============================================================================
// Farcaster manifest cache (fetched once at startup, refreshed periodically)
// ============================================================================

const MANIFEST_URL =
    'https://api.farcaster.xyz/miniapps/hosted-manifest/019c356b-6909-fbcf-3306-154b6483a2e4'
const MANIFEST_REFRESH_MS = 5 * 60 * 1000 // Refresh every 5 minutes

interface ManifestData {
    name: string
    homeUrl: string
    iconUrl: string
    imageUrl: string
    buttonTitle: string
    splashImageUrl: string
    splashBackgroundColor: string
}

// Defaults used until manifest is fetched
let manifestData: ManifestData = {
    name: '',
    homeUrl: MINIAPP_URL,
    iconUrl: 'https://airdrop-bot-tvql.onrender.com/icon.png',
    imageUrl: 'https://airdrop-bot-tvql.onrender.com/image.png',
    buttonTitle: 'Launch Airdrop App',
    splashImageUrl: 'https://airdrop-bot-tvql.onrender.com/icon.png',
    splashBackgroundColor: '#1a0533',
}

async function fetchManifest() {
    try {
        const res = await fetch(MANIFEST_URL)
        if (!res.ok) {
            console.warn(`[Manifest] Failed to fetch (${res.status}), using cached values`)
            return
        }
        const json = await res.json() as any
        const m = json?.frame || json?.miniapp
        if (m) {
            manifestData = {
                name: m.name || manifestData.name,
                homeUrl: m.homeUrl || manifestData.homeUrl,
                iconUrl: m.iconUrl || manifestData.iconUrl,
                imageUrl: m.imageUrl || manifestData.imageUrl,
                buttonTitle: m.buttonTitle || manifestData.buttonTitle,
                splashImageUrl: m.splashImageUrl || manifestData.splashImageUrl,
                splashBackgroundColor: m.splashBackgroundColor || manifestData.splashBackgroundColor,
            }
            console.log('[Manifest] Loaded from Farcaster:', manifestData.name)
        }
    } catch (err) {
        console.warn('[Manifest] Fetch error, using cached values:', err)
    }
}

// Fetch immediately, then refresh periodically
await fetchManifest()
setInterval(fetchManifest, MANIFEST_REFRESH_MS)

// Build dynamic HTML by injecting manifest values into the template
function buildMiniappHtml(): string {
    const htmlPath = join(__dirname, '..', 'public', 'miniapp.html')
    const template = readFileSync(htmlPath, 'utf-8')

    const m = manifestData
    const embedJson = JSON.stringify({
        version: '1',
        imageUrl: m.imageUrl,
        button: {
            title: m.buttonTitle,
            action: {
                type: 'launch_miniapp',
                name: m.name,
                url: m.homeUrl,
                splashImageUrl: m.splashImageUrl,
                splashBackgroundColor: m.splashBackgroundColor,
            },
        },
    })

    // Replace placeholder meta tags with live manifest values
    return template
        .replace('{{FC_MINIAPP_JSON}}', embedJson.replace(/'/g, '&#39;'))
        .replace('{{OG_TITLE}}', m.name)
        .replace('{{OG_IMAGE}}', m.imageUrl || m.iconUrl)
        .replace('{{PAGE_TITLE}}', m.name)
}

// ============================================================================
// Start Hono app and add custom routes
// ============================================================================

const app = bot.start()

// Serve miniapp HTML at both / and /miniapp.html
app.get('/', (c) => c.html(buildMiniappHtml()))
app.get('/miniapp.html', (c) => c.html(buildMiniappHtml()))

// Serve image routes – fetch from river.delivery once and cache in memory
const RIVER_IMAGE_URL = 'https://river.delivery/user/0xCC8ae8246f6FF472e7CDBa4aA973c2A91ba0C97c/image'
let cachedImage: { data: Uint8Array; contentType: string } | null = null

async function fetchAndCacheImage() {
    try {
        const res = await fetch(RIVER_IMAGE_URL)
        if (res.ok) {
            const buf = await res.arrayBuffer()
            const ct = res.headers.get('content-type') || 'image/png'
            cachedImage = { data: new Uint8Array(buf), contentType: ct }
            console.log(`[Image] Cached (${cachedImage.data.length} bytes, ${ct})`)
        } else {
            console.warn(`[Image] Fetch failed: ${res.status} ${res.statusText}`)
        }
    } catch (err) {
        console.warn('[Image] Fetch error:', err)
    }
}
await fetchAndCacheImage()

function serveImage(c: any) {
    if (!cachedImage) return c.redirect(RIVER_IMAGE_URL, 302)
    return new Response(cachedImage.data as unknown as BodyInit, {
        headers: {
            'Content-Type': cachedImage.contentType,
            'Content-Length': cachedImage.data.length.toString(),
            'Cache-Control': 'public, max-age=86400',
        },
    })
}

app.get('/icon.png', (c) => serveImage(c))
app.get('/image.png', (c) => serveImage(c))
app.get('/splash.png', (c) => serveImage(c))

// Agent metadata
app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

// Farcaster manifest redirect
app.get('/.well-known/farcaster.json', (c) => {
    return c.redirect(MANIFEST_URL, 307)
})

// ============================================================================
// API Routes
// ============================================================================

// Tax holders are stored in the database and refreshed every 24 hours
const TAX_HOLDER_REFRESH_MS = 24 * 60 * 60 * 1000 // 24 hours

async function refreshTaxHolders() {
    if (AIRDROP_TAX_PERCENT <= 0 || !isEthAddress(AIRDROP_TAX_NFT_ADDRESS)) return
    try {
        const rawHolders = await getMembershipNftHolderAddresses(
            bot as AnyBot,
            AIRDROP_TAX_NFT_ADDRESS as Address,
        )
        // No excludeAddresses for tax — all NFT holders receive tax
        const resolved = await getUniqueRecipientAddresses(
            bot as AnyBot,
            rawHolders.map((a) => a as string),
            { onlyResolved: false },
        )
        const holders = resolved.map((a) => a as string)
        saveTaxHolders(holders)
        console.log(`[Tax] Stored ${holders.length} tax holders in database`)
    } catch (err) {
        console.error('[Tax] Failed to refresh tax holders:', err)
    }
}

// Refresh if stale (>24h) or empty, then schedule every 24h
;(async () => {
    const lastUpdated = getTaxHoldersLastUpdated()
    const count = getTaxHolderCount()
    if (count === 0 || !lastUpdated || Date.now() - lastUpdated > TAX_HOLDER_REFRESH_MS) {
        console.log('[Tax] Tax holders stale or empty, refreshing...')
        await refreshTaxHolders()
    } else {
        console.log(`[Tax] ${count} tax holders in DB, last updated ${new Date(lastUpdated).toISOString()}`)
    }
})()
setInterval(refreshTaxHolders, TAX_HOLDER_REFRESH_MS)

// Token info lookup (name, symbol, decimals)
// Some tokens (like cbBTC) use bytes32 for name/symbol, so we try both ABIs
const ERC20_META_ABI = parseAbi([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
])
const ERC20_META_BYTES32_ABI = parseAbi([
    'function name() view returns (bytes32)',
    'function symbol() view returns (bytes32)',
])

function bytes32ToString(hex: string): string {
    // Convert a bytes32 hex to a UTF-8 string, stripping null bytes
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    let result = ''
    for (let i = 0; i < clean.length; i += 2) {
        const byte = parseInt(clean.slice(i, i + 2), 16)
        if (byte === 0) break
        result += String.fromCharCode(byte)
    }
    return result
}

app.get('/api/token-info', async (c) => {
    const address = (c.req.query('address') ?? '').trim()
    if (!isEthAddress(address)) {
        return c.json({ error: 'Invalid address' }, 400)
    }

    // Check DB cache first
    const cached = getTokenInfo(address)
    if (cached) {
        console.log(`[TokenInfo] Cache hit for ${address}: ${cached.symbol}`)
        return c.json({ name: cached.name, symbol: cached.symbol, decimals: cached.decimals, address: cached.address, cached: true })
    }

    try {
        // Try string ABI first, then bytes32 fallback
        const results = await multicall(bot.viem, {
            contracts: [
                { address: address as Address, abi: ERC20_META_ABI, functionName: 'name' },
                { address: address as Address, abi: ERC20_META_ABI, functionName: 'symbol' },
                { address: address as Address, abi: ERC20_META_ABI, functionName: 'decimals' },
                { address: address as Address, abi: ERC20_META_BYTES32_ABI, functionName: 'name' },
                { address: address as Address, abi: ERC20_META_BYTES32_ABI, functionName: 'symbol' },
            ],
            allowFailure: true,
        })
        let name = results[0].status === 'success' ? (results[0].result as string) : null
        let symbol = results[1].status === 'success' ? (results[1].result as string) : null
        const decimals = results[2].status === 'success' ? Number(results[2].result) : 18

        // Fallback to bytes32 if string failed
        if (!name && results[3].status === 'success') {
            name = bytes32ToString(results[3].result as string)
        }
        if (!symbol && results[4].status === 'success') {
            symbol = bytes32ToString(results[4].result as string)
        }

        if (!name && !symbol) {
            return c.json({ error: ' ERC20 token not found' }, 400)
        }

        // Store in DB cache for future lookups
        saveTokenInfo(address, name || '', symbol || '', decimals)
        console.log(`[TokenInfo] Cached token ${symbol} at ${address}`)

        return c.json({ name, symbol, decimals, address })
    } catch (err) {
        console.error('[TokenInfo] Error:', err)
        return c.json({ error: 'Failed to read token contract' }, 500)
    }
})

// Debug: inspect space holders cache & exclusions
app.get('/api/debug/space-holders', async (c) => {
    const nftAddress = (c.req.query('nft') ?? '').trim().toLowerCase()
    const checkAddress = (c.req.query('check') ?? '').trim().toLowerCase()
    const forceRefresh = c.req.query('refresh') === 'true'

    if (!nftAddress) {
        return c.json({ error: 'Missing ?nft= parameter (space NFT address)' }, 400)
    }

    // Force refresh the cache if requested
    if (forceRefresh) {
        try {
            const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
                .split(',').map(s => s.trim()).filter(Boolean)
            const holders = await getMembershipNftHolderAddresses(
                bot as AnyBot,
                nftAddress as Address,
            )
            const unique = (
                await getUniqueRecipientAddresses(
                    bot as AnyBot,
                    holders.map((a) => a as string),
                    { excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined, onlyResolved: false },
                )
            ).map((a) => a as string)
            saveSpaceHolders(nftAddress, unique)
            console.log(`[Debug] Force-refreshed ${unique.length} holders for ${nftAddress}`)
        } catch (err) {
            console.error(`[Debug] Force refresh failed:`, err)
            return c.json({ error: 'Force refresh failed', details: String(err) }, 500)
        }
    }

    const holders = getSpaceHolders(nftAddress)
    const lastUpdated = getSpaceHoldersLastUpdated(nftAddress)
    const isStale = isSpaceHoldersStale(nftAddress)
    const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const botApp = (bot.appAddress ?? '').toLowerCase()
    const botId = (bot.viem.account.address ?? '').toLowerCase()

    const result: any = {
        nftAddress,
        cachedHolderCount: holders?.length ?? 0,
        lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        isStale,
        wasRefreshed: forceRefresh,
        excludeAddresses,
        botAppAddress: botApp,
        botIdAddress: botId,
        holders: holders?.map(h => h.toLowerCase()) ?? [],
    }

    if (checkAddress) {
        const inCache = holders?.some(h => h.toLowerCase() === checkAddress) ?? false
        const isExcluded = excludeAddresses.includes(checkAddress)
        const isBotApp = checkAddress === botApp
        const isBotId = checkAddress === botId

        // Try to resolve userId → smart account to help debug
        let resolvedSmartAccount: string | null = null
        let resolvedInCache = false
        if (isEthAddress(checkAddress)) {
            try {
                const sa = await getSmartAccountFromUserId(bot as AnyBot, { userId: checkAddress as `0x${string}` })
                resolvedSmartAccount = (sa as string).toLowerCase()
                resolvedInCache = holders?.some(h => h.toLowerCase() === resolvedSmartAccount) ?? false
            } catch (err) {
                resolvedSmartAccount = `resolution failed: ${String(err)}`
            }
        }

        result.check = {
            address: checkAddress,
            inHoldersCache: inCache,
            resolvedSmartAccount,
            smartAccountInCache: resolvedInCache,
            isExcluded,
            isBotApp,
            isBotId,
            wouldBeIncluded: inCache && !isExcluded && !isBotApp && !isBotId,
            reason: !inCache && !resolvedInCache
                ? 'NOT in holders cache — try checking with your smart account address, or force refresh with &refresh=true'
                : !inCache && resolvedInCache
                ? `Your userId is not in cache, but your smart account (${resolvedSmartAccount}) IS — the bot uses smart accounts for matching`
                : isExcluded ? 'In AIRDROP_EXCLUDE_ADDRESSES list'
                : isBotApp ? 'Filtered as bot app address'
                : isBotId ? 'Filtered as bot signer address'
                : 'Would be included in airdrop'
        }
    }

    return c.json(result)
})

// Debug: resolve userId → smart account
app.get('/api/debug/resolve-wallet', async (c) => {
    const userId = (c.req.query('userId') ?? '').trim()
    if (!userId || !isEthAddress(userId)) {
        return c.json({ error: 'Missing or invalid ?userId= parameter' }, 400)
    }

    try {
        const smartAccount = await getSmartAccountFromUserId(bot as AnyBot, { userId: userId as `0x${string}` })
        const walletAddress = (smartAccount as string).toLowerCase()

        // Also check if there's a stored mapping
        const storedWallet = getUserWallet(userId)

        return c.json({
            userId: userId.toLowerCase(),
            resolvedSmartAccount: walletAddress,
            storedWalletMapping: storedWallet || null,
            match: storedWallet ? storedWallet.toLowerCase() === walletAddress : null,
        })
    } catch (err) {
        return c.json({
            userId: userId.toLowerCase(),
            resolvedSmartAccount: null,
            error: `Resolution failed: ${String(err)}`,
        })
    }
})

// Public config (tax rate, etc.)
app.get('/api/config', (c) => {
    const totalTax = AIRDROP_TAX_PERCENT + (isEthAddress(BOT_ADMIN_ADDRESS) ? AIRDROP_ADMIN_TAX_PERCENT : 0)
    return c.json({
        taxPercent: AIRDROP_TAX_PERCENT,
        adminTaxPercent: isEthAddress(BOT_ADMIN_ADDRESS) ? AIRDROP_ADMIN_TAX_PERCENT : 0,
        totalTaxPercent: totalTax,
        taxEnabled: AIRDROP_TAX_PERCENT > 0 && isEthAddress(AIRDROP_TAX_NFT_ADDRESS),
        adminTaxEnabled: AIRDROP_ADMIN_TAX_PERCENT > 0 && isEthAddress(BOT_ADMIN_ADDRESS),
        taxHolderCount: getTaxHolderCount(),
        taxNftAddress: AIRDROP_TAX_NFT_ADDRESS || null,
        botAddress: bot.appAddress,
        adminAddress: ADMIN_RIGHTS ? ADMIN_RIGHTS.toLowerCase() : null,
    })
})

// Get NFT holder count for a space (pass spaceId as query param)
// Uses DB cache first, falls back to on-chain fetch, stores result
app.get('/api/holders', async (c) => {
    const rawSpaceId = (c.req.query('spaceId') ?? '').trim()
    const extractedAddress = extractAddressFromStreamId(rawSpaceId)
    const nftAddress = extractedAddress
        || (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()

    console.log(`[Holders] rawSpaceId=${rawSpaceId}, extracted=${extractedAddress}, nftAddress=${nftAddress}`)

    if (!isEthAddress(nftAddress)) {
        return c.json({ error: 'No valid spaceId provided and AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 400)
    }

    try {
        const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

        // Fetch space name (uses DB cache internally)
        const spaceName = await fetchSpaceName(nftAddress)

        // Check DB cache first
        const cached = getSpaceHolders(nftAddress)
        if (cached && !isSpaceHoldersStale(nftAddress)) {
            console.log(`[Holders] Using cached ${cached.length} holders for ${nftAddress}`)
            // Apply exclude filter on cached data
            const excludeSet = new Set(excludeAddresses.map(a => a.toLowerCase()))
            const botApp = (bot.appAddress ?? '').toLowerCase()
            const botId = (bot.viem.account.address ?? '').toLowerCase()
            const filtered = cached.filter(a => {
                const lower = a.toLowerCase()
                return lower !== botApp && lower !== botId && !excludeSet.has(lower)
            })
            return c.json({
                count: filtered.length,
                nftAddress,
                spaceName,
                taxHolderCount: getTaxHolderCount(),
                botAddress: bot.appAddress,
                cached: true,
            })
        }

        // Fetch from chain
        const holders = await getMembershipNftHolderAddresses(
            bot as AnyBot,
            nftAddress as Address,
        )

        const uniqueRecipients = await getUniqueRecipientAddresses(
            bot as AnyBot,
            holders.map((a) => a as string),
            {
                excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined,
                onlyResolved: false,
            },
        )

        // Store in DB cache
        saveSpaceHolders(nftAddress, uniqueRecipients.map(a => a as string))
        console.log(`[Holders] Cached ${uniqueRecipients.length} holders for ${nftAddress}`)

        return c.json({
            count: uniqueRecipients.length,
            nftAddress,
            spaceName,
            taxHolderCount: getTaxHolderCount(),
            botAddress: bot.appAddress,
            cached: false,
        })
    } catch (err) {
        console.error('Failed to fetch holders:', err)
        return c.json({ error: 'Failed to fetch holders' }, 500)
    }
})

// Create airdrop
app.post('/api/airdrop', async (c) => {
    try {
        const body = await c.req.json()
        const {
            airdropType, totalAmount, creatorAddress, currency,
            currencySymbol: rawSymbol, spaceId, currencyDecimals: rawDecimals,
            creatorDisplayName, title: rawTitle, description: rawDescription,
            maxParticipants: rawMaxParticipants,
            spaceJoinMode: rawSpaceJoinMode,
        } = body

        if (!airdropType || !totalAmount || !creatorAddress) {
            return c.json({ error: 'Missing required fields' }, 400)
        }

        if (airdropType !== 'space' && airdropType !== 'public') {
            return c.json({ error: 'Invalid airdrop type (must be "space" or "public")' }, 400)
        }

        if (!isEthAddress(creatorAddress)) {
            return c.json({ error: 'Invalid creator address' }, 400)
        }

        // Default to $TOWNS if no currency provided
        const tokenAddress = (currency && isEthAddress(currency))
            ? currency
            : TOWNS_ADDRESS

        const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

        let recipientCount = 0
        let participants: string[] = []
        let spaceNftAddress: string | undefined

        const isSpaceJoinMode = airdropType === 'space' && rawSpaceJoinMode === true

        if (airdropType === 'space') {
            const extractedAddress = spaceId ? extractAddressFromStreamId(spaceId) : null
            const nftAddress = extractedAddress
                || (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()

            console.log(`[Airdrop] spaceId=${spaceId}, extracted=${extractedAddress}, nftAddress=${nftAddress}, joinMode=${isSpaceJoinMode}`)

            if (!isEthAddress(nftAddress)) {
                return c.json({ error: 'No valid spaceId provided and AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 400)
            }

            spaceNftAddress = nftAddress

            // Ensure space name is cached (for leaderboard & display)
            fetchSpaceName(nftAddress).catch(() => {})

            if (isSpaceJoinMode) {
                // Join mode: don't populate participants, they'll join later
                // Still ensure holders are cached so we can validate joins
                const cached = getSpaceHolders(nftAddress)
                if (!cached || isSpaceHoldersStale(nftAddress)) {
                    const holders = await getMembershipNftHolderAddresses(
                        bot as AnyBot,
                        nftAddress as Address,
                    )
                    const unique = (
                        await getUniqueRecipientAddresses(
                            bot as AnyBot,
                            holders.map((a) => a as string),
                            { excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined, onlyResolved: false },
                        )
                    ).map((a) => a as string)
                    saveSpaceHolders(nftAddress, unique)
                    console.log(`[Airdrop] Cached ${unique.length} holders for join-mode validation`)
                }
                recipientCount = 0
                participants = []
            } else {
                // All-holders mode: populate participants as before
                const cached = getSpaceHolders(nftAddress)
                if (cached && !isSpaceHoldersStale(nftAddress)) {
                    console.log(`[Airdrop] Using cached ${cached.length} holders for ${nftAddress}`)
                    const excludeSet = new Set(excludeAddresses.map(a => a.toLowerCase()))
                    const botApp = (bot.appAddress ?? '').toLowerCase()
                    const botId = (bot.viem.account.address ?? '').toLowerCase()
                    participants = cached.filter(a => {
                        const lower = a.toLowerCase()
                        return lower !== botApp && lower !== botId && !excludeSet.has(lower)
                    })
                } else {
                    const holders = await getMembershipNftHolderAddresses(
                        bot as AnyBot,
                        nftAddress as Address,
                    )
                    participants = (
                        await getUniqueRecipientAddresses(
                            bot as AnyBot,
                            holders.map((a) => a as string),
                            {
                                excludeAddresses:
                                    excludeAddresses.length > 0 ? excludeAddresses : undefined,
                                onlyResolved: false,
                            },
                        )
                    ).map((a) => a as string)
                    saveSpaceHolders(nftAddress, participants)
                    console.log(`[Airdrop] Cached ${participants.length} holders for ${nftAddress}`)
                }
                recipientCount = participants.length
            }
        }
        // For 'public' airdrops, participants join later

        // Tax holders come from the database (refreshed every 24h)
        const taxHolders = getTaxHolders()

        const totalBigInt = BigInt(totalAmount)
        const { holderTaxAmount, adminTaxAmount, netAmount } = computeTax(totalBigInt)
        const amountPer = recipientCount > 0 ? netAmount / BigInt(recipientCount) : 0n

        const airdrop: Airdrop = {
            id: generateId(),
            creatorAddress,
            airdropType,
            spaceNftAddress,
            currency: tokenAddress,
            currencySymbol: typeof rawSymbol === 'string' && rawSymbol
                ? rawSymbol
                : (tokenAddress.toLowerCase() === TOWNS_ADDRESS.toLowerCase() ? 'TOWNS' : ''),
            currencyDecimals: typeof rawDecimals === 'number' ? rawDecimals : 18,
            totalAmount,
            taxPercent: AIRDROP_TAX_PERCENT,
            taxAmount: holderTaxAmount.toString(),
            adminTaxPercent: isEthAddress(BOT_ADMIN_ADDRESS) ? AIRDROP_ADMIN_TAX_PERCENT : 0,
            adminTaxAmount: adminTaxAmount.toString(),
            netAmount: netAmount.toString(),
            amountPerRecipient: amountPer.toString(),
            recipientCount,
            status: 'pending',
            participants,
            taxHolders,
            title: typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 100) : undefined,
            description: typeof rawDescription === 'string' ? rawDescription.trim().slice(0, 500) : undefined,
            maxParticipants: ((airdropType === 'public' || isSpaceJoinMode) && typeof rawMaxParticipants === 'number' && rawMaxParticipants > 0)
                ? rawMaxParticipants
                : 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }

        saveAirdrop(airdrop)

        // Store creator display name
        if (creatorDisplayName) {
            setParticipantName(creatorAddress, creatorDisplayName)
        }

        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to create airdrop:', err)
        return c.json({ error: 'Failed to create airdrop' }, 500)
    }
})

// Get airdrop by ID
app.get('/api/airdrop/:id', (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }
    return c.json(airdropToResponse(airdrop))
})

// Request deposit via Towns interaction (sends tx prompt to user in channel)
app.post('/api/airdrop/:id/request-deposit', async (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.status !== 'pending') {
        return c.json({ error: 'Airdrop is not pending deposit' }, 400)
    }

    try {
        const body = await c.req.json()
        const { userId, channelId } = body

        if (!userId || !channelId) {
            return c.json({ error: 'Missing userId or channelId' }, 400)
        }

        const tokenAddress = (airdrop.currency || TOWNS_ADDRESS) as Address
        const totalAmount = BigInt(airdrop.totalAmount)
        const treasury = bot.appAddress as Address

        // Encode the ERC20 transfer(treasury, amount) calldata
        const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [treasury, totalAmount],
        })

        const tokenLabel = tokenAddress.toLowerCase() === TOWNS_ADDRESS.toLowerCase()
            ? '$TOWNS'
            : tokenAddress.slice(0, 8) + '...'

        // Format amount using the token's actual decimals
        const decimals = airdrop.currencyDecimals || 18
        const divisor = 10n ** BigInt(decimals)
        const whole = totalAmount / divisor
        const frac = totalAmount % divisor
        const fracStr = frac > 0n ? '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
        const humanAmount = `${whole}${fracStr}`

        const requestId = `deposit-${airdrop.id}`

        // Send transaction interaction request to the user in the channel
        // Uses the same pattern as the reflex-game example (handler.sendInteractionRequest)
        console.log(`[Deposit] Sending interaction request: ${requestId} to ${userId} in ${channelId}`)
        const result = await (bot as any).sendInteractionRequest(channelId, {
            type: 'transaction',
            id: requestId,
            title: 'Airdrop Deposit',
            subtitle: `Send ${humanAmount} ${tokenLabel}`,
            tx: {
                chainId: '8453',
                to: tokenAddress,
                value: '0',
                data,
            },
            recipient: userId,
        })

        // Store the interaction eventId and channelId so we can remove it after confirmation
        if (result?.eventId) {
            updateAirdrop(airdrop.id, {
                depositInteractionEventId: result.eventId,
                depositChannelId: channelId,
                updatedAt: Date.now(),
            })
            console.log(`[Deposit] Stored interaction eventId: ${result.eventId}`)
        }

        return c.json({ ok: true, message: 'Transaction request sent. Approve it in your Towns chat.' })
    } catch (err) {
        console.error('[Deposit] Failed to send interaction request:', err)
        return c.json({ error: 'Failed to send transaction request: ' + (err instanceof Error ? err.message : String(err)) }, 500)
    }
})

// Confirm deposit (manual tx hash fallback)
app.post('/api/airdrop/:id/confirm-deposit', async (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    try {
        const body = await c.req.json()
        const { txHash } = body

        if (!txHash) {
            return c.json({ error: 'Missing txHash' }, 400)
        }

        const receipt = await waitForTransactionReceipt(bot.viem, {
            hash: txHash as `0x${string}`,
        })

        if (receipt.status !== 'success') {
            return c.json({ error: 'Transaction failed on-chain' }, 400)
        }

        updateAirdrop(airdrop.id, { depositTxHash: txHash, status: 'funded', updatedAt: Date.now() })

        // Remove the deposit interaction request from chat
        if (airdrop.depositInteractionEventId && airdrop.depositChannelId) {
            try {
                await (bot as any).removeEvent(airdrop.depositChannelId, airdrop.depositInteractionEventId)
                console.log('[ConfirmDeposit] Removed deposit interaction from chat')
            } catch (err) {
                console.warn('[ConfirmDeposit] Failed to remove deposit interaction:', err)
            }
        }

        // Space airdrops: auto-distribute if all-holders mode, skip for join mode
        const isJoinableSpaceDeposit = airdrop.airdropType === 'space' && (airdrop.maxParticipants || 0) > 0
        if (airdrop.airdropType === 'space' && !isJoinableSpaceDeposit && airdrop.participants.length > 0) {
            updateAirdrop(airdrop.id, { status: 'distributing', updatedAt: Date.now() })
            const fresh = getAirdrop(airdrop.id)
            if (fresh) runDistribution(fresh).catch(console.error)
        }

        const updated = getAirdrop(airdrop.id)!
        return c.json(airdropToResponse(updated))
    } catch (err) {
        console.error('Failed to confirm deposit:', err)
        return c.json({ error: 'Failed to confirm deposit' }, 500)
    }
})

// Join airdrop (public or joinable space airdrops)
app.post('/api/airdrop/:id/join', async (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    // Allow public airdrops and space airdrops in join mode (maxParticipants > 0 with no pre-populated participants at creation)
    const isSpaceJoinable = airdrop.airdropType === 'space' && (airdrop.maxParticipants || 0) > 0
    if (airdrop.airdropType !== 'public' && !isSpaceJoinable) {
        return c.json({ error: 'Cannot join this airdrop' }, 400)
    }

    if (airdrop.status !== 'funded') {
        return c.json({ error: 'Airdrop not accepting participants' }, 400)
    }

    try {
        const body = await c.req.json()
        const { userAddress, userId, displayName } = body

        let walletAddress = ''

        if (userAddress && isEthAddress(userAddress)) {
            walletAddress = userAddress.toLowerCase()
        } else if (userId && isEthAddress(userId)) {
            // Resolve userId to smart wallet address
            try {
                const smartAccount = await getSmartAccountFromUserId(bot as AnyBot, { userId })
                walletAddress = (smartAccount as string).toLowerCase()
            } catch (err) {
                console.error(`[Join] Failed to resolve userId ${userId}:`, err)
                return c.json({ error: 'Failed to resolve wallet address' }, 500)
            }
        } else {
            return c.json({ error: 'Invalid wallet address' }, 400)
        }

        // Store display name and userId→wallet mapping
        if (displayName) {
            setParticipantName(walletAddress, displayName)
        }
        if (userId && isEthAddress(userId)) {
            setUserWallet(userId, walletAddress)
        }

        // For joinable space airdrops: verify the user is a space NFT holder
        if (isSpaceJoinable && airdrop.spaceNftAddress) {
            const holders = getSpaceHolders(airdrop.spaceNftAddress)
            if (holders) {
                const isHolder = holders.some(h => h.toLowerCase() === walletAddress.toLowerCase())
                if (!isHolder) {
                    return c.json({ error: 'Only space members can join this airdrop' }, 403)
                }
            } else {
                console.warn(`[Join] No cached holders for ${airdrop.spaceNftAddress}, allowing join`)
            }
        }

        // Check max participants
        const maxP = airdrop.maxParticipants || 0
        if (maxP > 0 && airdrop.participants.length >= maxP) {
            return c.json({ error: 'This airdrop has reached the maximum number of participants' }, 400)
        }

        // Case-insensitive duplicate check
        const alreadyJoined = airdrop.participants.some(p => p.toLowerCase() === walletAddress.toLowerCase())
        if (!alreadyJoined) {
            const newParticipants = [...airdrop.participants, walletAddress]
            const newCount = newParticipants.length

            // Recalculate per-recipient using net amount (after tax)
            const net = BigInt(airdrop.netAmount)
            const newAmountPer = (net / BigInt(newCount)).toString()

            updateAirdrop(airdrop.id, {
                participants: newParticipants,
                amountPerRecipient: newAmountPer,
                updatedAt: Date.now(),
            })

            console.log(`[Join] User ${walletAddress} joined airdrop ${airdrop.id} (${newCount}/${maxP || '∞'} participants)`)

            // Auto-distribute when max participants reached (with 10s countdown)
            if (maxP > 0 && newCount >= maxP) {
                console.log(`[AutoDistribute] Max participants (${maxP}) reached for ${airdrop.id}, starting 10s countdown`)
                // Set status so frontend shows countdown, then distribute after delay
                setTimeout(() => {
                    console.log(`[AutoDistribute] Countdown finished for ${airdrop.id}, starting distribution`)
                    updateAirdrop(airdrop.id, { status: 'distributing', updatedAt: Date.now() })
                    const fresh = getAirdrop(airdrop.id)
                    if (fresh) {
                        runDistribution(fresh).catch(err => {
                            console.error(`[AutoDistribute] Distribution failed for ${airdrop.id}:`, err)
                        })
                    } else {
                        console.error(`[AutoDistribute] Could not re-read airdrop ${airdrop.id} from DB`)
                    }
                }, 10_000)
            }
        } else {
            console.log(`[Join] User ${walletAddress} already joined airdrop ${airdrop.id}`)
        }

        const updated = getAirdrop(airdrop.id)!
        return c.json(airdropToResponse(updated))
    } catch (err) {
        console.error('Failed to join airdrop:', err)
        return c.json({ error: 'Failed to join airdrop' }, 500)
    }
})

// Launch airdrop (react mode)
app.post('/api/airdrop/:id/launch', async (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.status !== 'funded') {
        return c.json({ error: 'Airdrop cannot be launched' }, 400)
    }

    if (airdrop.participants.length === 0) {
        return c.json({ error: 'No participants to distribute to' }, 400)
    }

    updateAirdrop(airdrop.id, { status: 'distributing', updatedAt: Date.now() })

    const fresh = getAirdrop(airdrop.id)!
    runDistribution(fresh).catch(console.error)

    return c.json(airdropToResponse(fresh))
})

// Cancel airdrop
app.post('/api/airdrop/:id/cancel', async (c) => {
    const airdrop = getAirdrop(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.status === 'completed' || airdrop.status === 'distributing') {
        return c.json({ error: 'Cannot cancel airdrop in current state' }, 400)
    }

    updateAirdrop(airdrop.id, { status: 'cancelled', updatedAt: Date.now() })

    const updated = getAirdrop(airdrop.id)!
    return c.json(airdropToResponse(updated))
})

// Admin: cancel any airdrop (with refund if funded)
app.post('/api/airdrop/:id/admin-cancel', async (c) => {
    try {
        const body = await c.req.json()
        const { userId } = body

        // Verify caller is admin
        if (!userId || !isAdminUser(userId)) {
            return c.json({ error: 'Unauthorized: admin only' }, 403)
        }

        const airdrop = getAirdrop(c.req.param('id'))
        if (!airdrop) {
            return c.json({ error: 'Airdrop not found' }, 404)
        }

        if (airdrop.status === 'completed' || airdrop.status === 'distributing') {
            return c.json({ error: 'Cannot cancel: already distributed or distributing' }, 400)
        }

        let refundTxHash: string | undefined

        // If funded, refund the total amount back to creator's wallet
        if (airdrop.status === 'funded') {
            const creatorId = airdrop.creatorAddress
            let refundAddress: Address | null = null

            // Try user_wallets mapping first
            const knownWallet = getUserWallet(creatorId)
            if (knownWallet && isEthAddress(knownWallet)) {
                refundAddress = knownWallet as Address
            } else if (isEthAddress(creatorId)) {
                // Resolve userId to smart wallet
                try {
                    const smartAccount = await getSmartAccountFromUserId(bot as AnyBot, { userId: creatorId })
                    refundAddress = smartAccount as Address
                } catch (err) {
                    console.error(`[AdminCancel] Failed to resolve creator wallet for ${creatorId}:`, err)
                }
            }

            if (!refundAddress) {
                return c.json({ error: 'Cannot resolve creator wallet for refund' }, 500)
            }

            const totalAmount = BigInt(airdrop.totalAmount)
            const tokenAddress = (airdrop.currency || TOWNS_ADDRESS) as Address
            const botAddress = bot.appAddress as Address

            console.log(`[AdminCancel] Refunding ${totalAmount} to ${refundAddress} for airdrop ${airdrop.id}`)

            const result = await runBotDistribution(
                [refundAddress],
                totalAmount,
                totalAmount,
                botAddress,
                tokenAddress,
            )

            if (!result.ok) {
                console.error(`[AdminCancel] Refund failed:`, result.error)
                return c.json({ error: `Refund failed: ${result.error}` }, 500)
            }

            refundTxHash = result.txHash
            console.log(`[AdminCancel] Refund sent: ${refundTxHash}`)
        }

        updateAirdrop(airdrop.id, { status: 'cancelled', updatedAt: Date.now() })

        const updated = getAirdrop(airdrop.id)!
        return c.json({ ...airdropToResponse(updated), refundTxHash })
    } catch (err) {
        console.error('[AdminCancel] Error:', err)
        return c.json({ error: 'Failed to cancel airdrop' }, 500)
    }
})

// Admin: reset leaderboard (deletes completed/cancelled airdrops)
app.post('/api/admin/reset-leaderboard', async (c) => {
    try {
        const body = await c.req.json()
        const { userId } = body

        if (!userId || !isAdminUser(userId)) {
            return c.json({ error: 'Unauthorized: admin only' }, 403)
        }

        resetLeaderboard()
        console.log(`[Admin] Leaderboard reset at ${Date.now()}`)
        return c.json({ ok: true })
    } catch (err) {
        console.error('[Admin] Reset leaderboard error:', err)
        return c.json({ error: 'Failed to reset leaderboard' }, 500)
    }
})

// Admin: reset history (deletes all non-active airdrops)
app.post('/api/admin/reset-history', async (c) => {
    try {
        const body = await c.req.json()
        const { userId } = body

        if (!userId || !isAdminUser(userId)) {
            return c.json({ error: 'Unauthorized: admin only' }, 403)
        }

        const count = deleteHistoryAirdrops()
        console.log(`[Admin] History reset: deleted ${count} airdrops`)
        return c.json({ ok: true, deleted: count })
    } catch (err) {
        console.error('[Admin] Reset history error:', err)
        return c.json({ error: 'Failed to reset history' }, 500)
    }
})

// List public airdrops (joinable — pending or funded only)
app.get('/api/public-airdrops', (c) => {
    const publicDrops = listPublicAirdrops().map(airdropToResponse)
    return c.json(publicDrops)
})

// Airdrop history (completed/cancelled/distributing — excludes public pending/funded)
app.get('/api/airdrop-history', (c) => {
    const history = listAirdropHistory().map(airdropToResponse)
    return c.json(history)
})

// Leaderboard
app.get('/api/leaderboard', async (c) => {
    const topRecipients = getTopRecipients(5)
    const topCreators = getTopCreators(5)
    const topSpaces = getTopSpaces(5)

    // Enrich with display names
    const allAddresses = [
        ...topRecipients.map(r => r.address),
        ...topCreators.map(r => r.address),
    ]
    const names = getParticipantNames(allAddresses)

    // For addresses without display names, try to find a short label via reverse wallet lookup
    const missingAddresses = allAddresses.filter(a => !names.has(a.toLowerCase()))
    if (missingAddresses.length > 0) {
        const reverseMap = getUserIdsByWallets(missingAddresses)
        for (const [wallet, userId] of reverseMap) {
            if (!names.has(wallet)) {
                // Use shortened EOA as a fallback display name
                const short = userId.slice(0, 6) + '...' + userId.slice(-4)
                names.set(wallet, short)
            }
        }
    }

    // Fetch missing space names (for spaces that weren't named yet)
    const enrichedSpaces = await Promise.all(
        topSpaces.map(async (s) => {
            if (!s.spaceName && s.spaceNftAddress) {
                const name = await fetchSpaceName(s.spaceNftAddress)
                return { ...s, spaceName: name || null }
            }
            return s
        })
    )

    return c.json({
        topRecipients: topRecipients.map(r => ({
            ...r,
            displayName: names.get(r.address.toLowerCase()) || null,
        })),
        topCreators: topCreators.map(r => ({
            ...r,
            displayName: names.get(r.address.toLowerCase()) || null,
        })),
        topSpaces: enrichedSpaces,
    })
})

// List airdrops created by a specific user
app.get('/api/my-airdrops/:address', (c) => {
    const addr = c.req.param('address')
    const myDrops = listAirdropsByCreator(addr).map(airdropToResponse)
    return c.json(myDrops)
})

// Resolve userId to known wallet address
app.get('/api/user-wallet', (c) => {
    const userId = (c.req.query('userId') ?? '').trim()
    if (!userId || !isEthAddress(userId)) {
        return c.json({ wallet: null })
    }
    const wallet = getUserWallet(userId)
    return c.json({ wallet })
})

// Admin: get treasury token balance
app.get('/api/admin/treasury-balance', async (c) => {
    const tokenAddress = (c.req.query('token') ?? '').trim()
    if (!tokenAddress || !isEthAddress(tokenAddress)) {
        return c.json({ error: 'Invalid token address' }, 400)
    }

    try {
        const treasury = bot.appAddress as Address
        const balance = await readContract(bot.viem, {
            address: tokenAddress as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [treasury],
        })
        return c.json({ balance: balance.toString(), treasury })
    } catch (err) {
        console.error('[TreasuryBalance] Error:', err)
        return c.json({ error: 'Failed to read balance' }, 500)
    }
})

// Admin: recover funds from treasury to admin wallet
app.post('/api/admin/recover-funds', async (c) => {
    try {
        const body = await c.req.json()
        const { userId, tokenAddress, amount } = body

        if (!userId || !isAdminUser(userId)) {
            return c.json({ error: 'Unauthorized: admin only' }, 403)
        }

        if (!tokenAddress || !isEthAddress(tokenAddress)) {
            return c.json({ error: 'Invalid token address' }, 400)
        }

        if (!amount || BigInt(amount) <= 0n) {
            return c.json({ error: 'Invalid amount' }, 400)
        }

        // Resolve admin's smart wallet for receiving funds
        let recipientAddress: Address | null = null

        // Try ADMIN_RIGHTS userId → smart wallet
        const knownWallet = getUserWallet(userId)
        if (knownWallet && isEthAddress(knownWallet)) {
            recipientAddress = knownWallet as Address
        } else {
            // Resolve via SDK
            try {
                const smartAccount = await getSmartAccountFromUserId(bot as AnyBot, { userId })
                recipientAddress = smartAccount as Address
                setUserWallet(userId, smartAccount as string)
            } catch (err) {
                console.error(`[Recover] Failed to resolve admin wallet for ${userId}:`, err)
            }
        }

        if (!recipientAddress) {
            return c.json({ error: 'Cannot resolve admin wallet address' }, 500)
        }

        const totalAmount = BigInt(amount)
        const botAddress = bot.appAddress as Address

        console.log(`[Recover] Sending ${totalAmount} of ${tokenAddress} from ${botAddress} to ${recipientAddress}`)

        const result = await runBotDistribution(
            [recipientAddress],
            totalAmount,
            totalAmount,
            botAddress,
            tokenAddress as Address,
        )

        if (!result.ok) {
            console.error('[Recover] Transfer failed:', result.error)
            return c.json({ error: `Transfer failed: ${result.error}` }, 500)
        }

        console.log(`[Recover] Success: ${result.txHash}`)
        return c.json({ ok: true, txHash: result.txHash, recipient: recipientAddress })
    } catch (err) {
        console.error('[Recover] Error:', err)
        return c.json({ error: 'Failed to recover funds' }, 500)
    }
})

// Health check
app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        airdrops: getAirdropCount(),
    })
})

// ============================================================================
// Export app (same pattern as reflex-game example)
// ============================================================================

export default app
