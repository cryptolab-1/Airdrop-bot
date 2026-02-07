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
import { erc20Abi } from 'viem'
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

// ============================================================================
// Constants
// ============================================================================

const TOWNS_ADDRESS = '0x00000000A22C618fd6b4D7E9A335C4B96B189a38' as const
const MAX_TRANSFERS_PER_BATCH = 80
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

const ERC721_HOLDERS_ABI = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
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

// ============================================================================
// Bot initialization
// ============================================================================

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

console.log(`[Bot] Gas wallet: ${bot.viem.account.address}`)
console.log(`[Bot] Treasury:   ${bot.appAddress}`)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MINIAPP_URL = process.env.MINIAPP_URL || `${process.env.BASE_URL}/miniapp.html`

// ============================================================================
// Types
// ============================================================================

type AnyBot = Bot<BotCommand[]>

type AirdropStatus = 'pending' | 'funded' | 'distributing' | 'completed' | 'cancelled'

interface Airdrop {
    id: string
    creatorAddress: string
    mode: 'fixed' | 'react'
    totalAmount: string
    amountPerRecipient: string
    recipientCount: number
    status: AirdropStatus
    participants: string[]
    depositTxHash?: string
    distributionTxHash?: string
    createdAt: number
    updatedAt: number
}

// In-memory store (use a database in production)
const airdrops = new Map<string, Airdrop>()

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

function generateId(): string {
    return `airdrop_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function airdropToResponse(a: Airdrop) {
    return {
        id: a.id,
        creatorAddress: a.creatorAddress,
        totalAmount: a.totalAmount,
        amountPerRecipient: a.amountPerRecipient,
        recipientCount: a.recipientCount,
        status: a.status,
        participants: a.participants,
        txHash: a.distributionTxHash || a.depositTxHash,
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
    }
    return out
}

// ---- Distribution ----------------------------------------------------------

async function runBotDistribution(
    recipients: Address[],
    amountPer: bigint,
    _totalRaw: bigint,
    fromAddress: Address,
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
                        to: TOWNS_ADDRESS as Address,
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
    const totalRaw = BigInt(airdrop.totalAmount)
    const recipients = airdrop.participants.map((a) => a as Address)

    const result = await runBotDistribution(recipients, amountPer, totalRaw, botAddress)

    if (result.ok) {
        airdrop.status = 'completed'
        airdrop.distributionTxHash = result.txHash
    } else {
        airdrop.status = 'funded'
        console.error('Distribution failed:', result.error)
    }

    airdrop.updatedAt = Date.now()
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

    await handler.sendMessage(channelId, 'Click below to open the airdrop app:', {
        attachments: [
            {
                type: 'miniapp',
                url: MINIAPP_URL,
            },
        ],
    })
})

// ============================================================================
// Start Hono app and add custom routes
// ============================================================================

const app = bot.start()

// Serve miniapp HTML (same pattern as reflex-game example)
app.get('/miniapp.html', (c) => {
    try {
        const htmlPath = join(__dirname, '..', 'public', 'miniapp.html')
        const html = readFileSync(htmlPath, 'utf-8')
        return c.html(html)
    } catch (error) {
        console.error('Failed to serve miniapp:', error)
        return c.text('Miniapp not found', 404)
    }
})

// Serve image
app.get('/image.png', (c) => {
    try {
        const imagePath = join(__dirname, '..', 'public', 'image.png')
        const image = readFileSync(imagePath)
        c.header('Content-Type', 'image/png')
        return c.body(image)
    } catch {
        return c.text('Image not found', 404)
    }
})

// Agent metadata
app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

// Farcaster manifest redirect (same pattern as Farcaster dashboard instructs)
app.get('/.well-known/farcaster.json', (c) => {
    return c.redirect(
        'https://api.farcaster.xyz/miniapps/hosted-manifest/019c356b-6909-fbcf-3306-154b6483a2e4',
        307,
    )
})

// ============================================================================
// API Routes
// ============================================================================

// Get NFT holder count
app.get('/api/holders', async (c) => {
    const nftAddress = (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()

    if (!isEthAddress(nftAddress)) {
        return c.json({ error: 'AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 500)
    }

    try {
        const holders = await getMembershipNftHolderAddresses(
            bot as AnyBot,
            nftAddress as Address,
        )
        const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

        const uniqueRecipients = await getUniqueRecipientAddresses(
            bot as AnyBot,
            holders.map((a) => a as string),
            {
                excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined,
                onlyResolved: false,
            },
        )

        return c.json({
            count: uniqueRecipients.length,
            botAddress: bot.appAddress,
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
        const { mode, totalAmount, creatorAddress } = body

        if (!mode || !totalAmount || !creatorAddress) {
            return c.json({ error: 'Missing required fields' }, 400)
        }

        if (!isEthAddress(creatorAddress)) {
            return c.json({ error: 'Invalid creator address' }, 400)
        }

        const nftAddress = (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()
        if (!isEthAddress(nftAddress)) {
            return c.json({ error: 'AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 500)
        }

        let recipientCount = 0
        let participants: string[] = []

        if (mode === 'fixed') {
            const holders = await getMembershipNftHolderAddresses(
                bot as AnyBot,
                nftAddress as Address,
            )
            const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)

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

            recipientCount = participants.length
        }

        const totalBigInt = BigInt(totalAmount)
        const amountPer = recipientCount > 0 ? totalBigInt / BigInt(recipientCount) : 0n

        const airdrop: Airdrop = {
            id: generateId(),
            creatorAddress,
            mode,
            totalAmount,
            amountPerRecipient: amountPer.toString(),
            recipientCount,
            status: 'pending',
            participants,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }

        airdrops.set(airdrop.id, airdrop)

        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to create airdrop:', err)
        return c.json({ error: 'Failed to create airdrop' }, 500)
    }
})

// Get airdrop by ID
app.get('/api/airdrop/:id', (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }
    return c.json(airdropToResponse(airdrop))
})

// Confirm deposit
app.post('/api/airdrop/:id/confirm-deposit', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
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

        airdrop.depositTxHash = txHash
        airdrop.status = 'funded'
        airdrop.updatedAt = Date.now()

        if (airdrop.mode === 'fixed' && airdrop.participants.length > 0) {
            airdrop.status = 'distributing'
            runDistribution(airdrop).catch(console.error)
        }

        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to confirm deposit:', err)
        return c.json({ error: 'Failed to confirm deposit' }, 500)
    }
})

// Join airdrop (react mode)
app.post('/api/airdrop/:id/join', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.mode !== 'react') {
        return c.json({ error: 'Cannot join fixed airdrop' }, 400)
    }

    if (airdrop.status !== 'funded') {
        return c.json({ error: 'Airdrop not accepting participants' }, 400)
    }

    try {
        const body = await c.req.json()
        const { userAddress } = body

        if (!userAddress || !isEthAddress(userAddress)) {
            return c.json({ error: 'Invalid user address' }, 400)
        }

        if (!airdrop.participants.includes(userAddress.toLowerCase())) {
            airdrop.participants.push(userAddress.toLowerCase())
            airdrop.recipientCount = airdrop.participants.length

            const totalBigInt = BigInt(airdrop.totalAmount)
            airdrop.amountPerRecipient = (
                totalBigInt / BigInt(airdrop.recipientCount)
            ).toString()
            airdrop.updatedAt = Date.now()
        }

        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to join airdrop:', err)
        return c.json({ error: 'Failed to join airdrop' }, 500)
    }
})

// Launch airdrop (react mode)
app.post('/api/airdrop/:id/launch', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.status !== 'funded') {
        return c.json({ error: 'Airdrop cannot be launched' }, 400)
    }

    if (airdrop.participants.length === 0) {
        return c.json({ error: 'No participants to distribute to' }, 400)
    }

    airdrop.status = 'distributing'
    airdrop.updatedAt = Date.now()

    runDistribution(airdrop).catch(console.error)

    return c.json(airdropToResponse(airdrop))
})

// Cancel airdrop
app.post('/api/airdrop/:id/cancel', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.status === 'completed' || airdrop.status === 'distributing') {
        return c.json({ error: 'Cannot cancel airdrop in current state' }, 400)
    }

    airdrop.status = 'cancelled'
    airdrop.updatedAt = Date.now()

    return c.json(airdropToResponse(airdrop))
})

// Health check
app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        airdrops: airdrops.size,
    })
})

// ============================================================================
// Export app (same pattern as reflex-game example)
// ============================================================================

export default app
