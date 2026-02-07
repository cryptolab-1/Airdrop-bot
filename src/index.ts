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
import { deflateSync } from 'node:zlib'
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

// Tax system: a percentage of each airdrop is distributed to town members
const AIRDROP_TAX_PERCENT = Math.max(
    0,
    Math.min(100, parseFloat(process.env.AIRDROP_TAX_PERCENT ?? '2')),
)
const AIRDROP_TAX_NFT_ADDRESS = (process.env.AIRDROP_TAX_NFT_ADDRESS ?? '').trim()

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
    airdropType: 'space' | 'public'
    spaceNftAddress?: string // The space's membership NFT contract (= spaceId)
    currency: string // ERC20 token contract address
    currencyDecimals: number // Token decimals (default 18)
    totalAmount: string // gross amount deposited
    taxPercent: number // e.g. 2 means 2%
    taxAmount: string // wei taken as tax
    netAmount: string // totalAmount - taxAmount (distributed to recipients)
    amountPerRecipient: string
    recipientCount: number
    status: AirdropStatus
    participants: string[]
    taxHolders: string[] // Pre-fetched tax recipients (town members)
    depositTxHash?: string
    distributionTxHash?: string
    taxDistributionTxHash?: string
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

/** Calculate tax and net amounts from a gross total. */
function computeTax(totalWei: bigint): { taxAmount: bigint; netAmount: bigint } {
    // Use basis points (2% = 200 bps) for precision
    const bps = BigInt(Math.round(AIRDROP_TAX_PERCENT * 100))
    const taxAmount = (totalWei * bps) / 10000n
    const netAmount = totalWei - taxAmount
    return { taxAmount, netAmount }
}

function airdropToResponse(a: Airdrop) {
    return {
        id: a.id,
        creatorAddress: a.creatorAddress,
        airdropType: a.airdropType,
        spaceNftAddress: a.spaceNftAddress || null,
        currency: a.currency,
        currencyDecimals: a.currencyDecimals,
        totalAmount: a.totalAmount,
        taxPercent: a.taxPercent,
        taxAmount: a.taxAmount,
        netAmount: a.netAmount,
        amountPerRecipient: a.amountPerRecipient,
        recipientCount: a.recipientCount,
        status: a.status,
        participants: a.participants,
        participantNames: Object.fromEntries(
            a.participants.map(p => [p, participantNames.get(p) || null])
        ),
        taxHolderCount: a.taxHolders.length,
        txHash: a.distributionTxHash || a.depositTxHash,
        mode: a.airdropType === 'space' ? 'fixed' : 'react', // backward compat
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
        airdrop.status = 'funded'
        console.error('[Distribution] Main distribution failed:', result.error)
        airdrop.updatedAt = Date.now()
        return
    }

    airdrop.distributionTxHash = result.txHash

    // 2. Distribute tax to town members (using pre-fetched holders)
    const taxAmount = BigInt(airdrop.taxAmount)
    if (taxAmount > 0n && airdrop.taxHolders.length > 0) {
        try {
            const taxRecipients = airdrop.taxHolders.map((a) => a as Address)
            console.log(`[Tax] Distributing ${taxAmount} tax to ${taxRecipients.length} pre-fetched town members`)

            const taxPerMember = taxAmount / BigInt(taxRecipients.length)
            if (taxPerMember > 0n) {
                const taxResult = await runBotDistribution(
                    taxRecipients,
                    taxPerMember,
                    taxAmount,
                    botAddress,
                    tokenAddress,
                )
                if (taxResult.ok) {
                    airdrop.taxDistributionTxHash = taxResult.txHash
                    console.log(`[Tax] Distributed to ${taxRecipients.length} town members (tx: ${taxResult.txHash})`)
                } else {
                    console.error('[Tax] Tax distribution failed:', taxResult.error)
                }
            }
        } catch (err) {
            console.error('[Tax] Error during tax distribution:', err)
        }
    } else if (taxAmount > 0n) {
        console.warn('[Tax] No pre-fetched tax holders available, skipping tax distribution')
    }

    airdrop.status = 'completed'
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
        const airdrop = airdrops.get(airdropId)
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
        airdrop.depositTxHash = txHash
        airdrop.status = 'funded'
        airdrop.updatedAt = Date.now()
        console.log('[InteractionResponse] Deposit confirmed for', airdropId)

        // Space airdrops auto-distribute
        if (airdrop.airdropType === 'space' && airdrop.participants.length > 0) {
            airdrop.status = 'distributing'
            airdrop.updatedAt = Date.now()
            await handler.sendMessage(event.channelId, `Deposit confirmed! Distributing to ${airdrop.participants.length} recipients...`)
            runDistribution(airdrop).catch(console.error)
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
    splashImageUrl: 'https://airdrop-bot-tvql.onrender.com/splash.png',
    splashBackgroundColor: '#7C3AED',
}

async function fetchManifest() {
    try {
        const res = await fetch(MANIFEST_URL)
        if (!res.ok) {
            console.warn(`[Manifest] Failed to fetch (${res.status}), using cached values`)
            return
        }
        const json = await res.json() as any
        const m = json?.miniapp
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

// ---- PNG image generation (solid color, no external files needed) ----

function createPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
    // Build raw RGBA scanlines: filter byte (0) + RGBA per pixel
    const rowBytes = 1 + width * 4
    const raw = new Uint8Array(rowBytes * height)
    for (let y = 0; y < height; y++) {
        const offset = y * rowBytes
        raw[offset] = 0 // filter: None
        for (let x = 0; x < width; x++) {
            const px = offset + 1 + x * 4
            raw[px] = r
            raw[px + 1] = g
            raw[px + 2] = b
            raw[px + 3] = 255 // alpha
        }
    }

    const compressed = deflateSync(raw)

    // CRC-32 table
    const crcTable: number[] = []
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        crcTable[n] = c
    }
    function crc32(buf: Uint8Array): number {
        let c = 0xffffffff
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
        return (c ^ 0xffffffff) >>> 0
    }

    function chunk(type: string, data: Uint8Array): Uint8Array {
        const len = data.length
        const buf = new Uint8Array(12 + len)
        const view = new DataView(buf.buffer)
        view.setUint32(0, len)
        buf[4] = type.charCodeAt(0)
        buf[5] = type.charCodeAt(1)
        buf[6] = type.charCodeAt(2)
        buf[7] = type.charCodeAt(3)
        buf.set(data, 8)
        const crcData = new Uint8Array(4 + len)
        crcData.set(buf.subarray(4, 8 + len))
        view.setUint32(8 + len, crc32(crcData))
        return buf
    }

    // IHDR
    const ihdr = new Uint8Array(13)
    const ihdrView = new DataView(ihdr.buffer)
    ihdrView.setUint32(0, width)
    ihdrView.setUint32(4, height)
    ihdr[8] = 8  // bit depth
    ihdr[9] = 6  // RGBA
    ihdr[10] = 0 // compression
    ihdr[11] = 0 // filter
    ihdr[12] = 0 // interlace

    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const ihdrChunk = chunk('IHDR', ihdr)
    const idatChunk = chunk('IDAT', compressed)
    const iendChunk = chunk('IEND', new Uint8Array(0))

    const png = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
    png.set(signature, 0)
    png.set(ihdrChunk, signature.length)
    png.set(idatChunk, signature.length + ihdrChunk.length)
    png.set(iendChunk, signature.length + ihdrChunk.length + idatChunk.length)
    return png
}

// Pre-generate fallback images at startup (purple #7C3AED = rgb(124, 58, 237))
const FALLBACK_ICON = createPng(512, 512, 124, 58, 237)
const FALLBACK_IMAGE = createPng(1200, 630, 124, 58, 237)
const FALLBACK_SPLASH = createPng(200, 200, 124, 58, 237)

// Fetch profile image from river.delivery and cache it
const RIVER_IMAGE_URL = 'https://river.delivery/user/0xCC8ae8246f6FF472e7CDBa4aA973c2A91ba0C97c/image'
let cachedProfileImage: { data: Uint8Array; contentType: string } | null = null

async function fetchProfileImage() {
    try {
        const res = await fetch(RIVER_IMAGE_URL)
        if (res.ok) {
            const buf = await res.arrayBuffer()
            const contentType = res.headers.get('content-type') || 'image/jpeg'
            cachedProfileImage = { data: new Uint8Array(buf), contentType }
            console.log(`[Image] Cached profile image (${cachedProfileImage.data.length} bytes, ${contentType})`)
        } else {
            console.warn(`[Image] Failed to fetch profile image: ${res.status}`)
        }
    } catch (err) {
        console.warn('[Image] Error fetching profile image:', err)
    }
}

await fetchProfileImage()
// Refresh the image periodically (every hour)
setInterval(fetchProfileImage, 60 * 60 * 1000)

// Serve images
function serveImage(c: any, data: Uint8Array, contentType: string) {
    c.header('Content-Type', contentType)
    c.header('Content-Length', data.length.toString())
    c.header('Cache-Control', 'public, max-age=86400')
    return c.body(data)
}

app.get('/icon.png', (c) => {
    if (cachedProfileImage) return serveImage(c, cachedProfileImage.data, cachedProfileImage.contentType)
    return serveImage(c, FALLBACK_ICON, 'image/png')
})
app.get('/image.png', (c) => {
    if (cachedProfileImage) return serveImage(c, cachedProfileImage.data, cachedProfileImage.contentType)
    return serveImage(c, FALLBACK_IMAGE, 'image/png')
})
app.get('/splash.png', (c) => {
    if (cachedProfileImage) return serveImage(c, cachedProfileImage.data, cachedProfileImage.contentType)
    return serveImage(c, FALLBACK_SPLASH, 'image/png')
})

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

// Cached tax holder count (populated at startup and refreshed periodically)
let cachedTaxHolderCount = 0

async function refreshTaxHolderCount() {
    if (AIRDROP_TAX_PERCENT <= 0 || !isEthAddress(AIRDROP_TAX_NFT_ADDRESS)) return
    try {
        const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        const rawHolders = await getMembershipNftHolderAddresses(
            bot as AnyBot,
            AIRDROP_TAX_NFT_ADDRESS as Address,
        )
        const resolved = await getUniqueRecipientAddresses(
            bot as AnyBot,
            rawHolders.map((a) => a as string),
            {
                excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined,
                onlyResolved: false,
            },
        )
        cachedTaxHolderCount = resolved.length
        console.log(`[Tax] Cached tax holder count: ${cachedTaxHolderCount}`)
    } catch (err) {
        console.error('[Tax] Failed to refresh tax holder count:', err)
    }
}

// Refresh at startup and every 5 minutes
refreshTaxHolderCount()
setInterval(refreshTaxHolderCount, 5 * 60 * 1000)

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
            return c.json({ error: 'Not a valid ERC20 token' }, 400)
        }
        return c.json({ name, symbol, decimals, address })
    } catch (err) {
        console.error('[TokenInfo] Error:', err)
        return c.json({ error: 'Failed to read token contract' }, 500)
    }
})

// Public config (tax rate, etc.)
app.get('/api/config', (c) => {
    return c.json({
        taxPercent: AIRDROP_TAX_PERCENT,
        taxEnabled: AIRDROP_TAX_PERCENT > 0 && isEthAddress(AIRDROP_TAX_NFT_ADDRESS),
        taxHolderCount: cachedTaxHolderCount,
        botAddress: bot.appAddress,
    })
})

// Get NFT holder count for a space (pass spaceId as query param)
app.get('/api/holders', async (c) => {
    // Use spaceId from query param (= the space's membership NFT contract)
    // The spaceId may be a raw address or an encoded Towns stream ID
    // Fall back to AIRDROP_MEMBERSHIP_NFT_ADDRESS env for backward compat
    const rawSpaceId = (c.req.query('spaceId') ?? '').trim()
    const extractedAddress = extractAddressFromStreamId(rawSpaceId)
    const nftAddress = extractedAddress
        || (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()

    console.log(`[Holders] rawSpaceId=${rawSpaceId}, extracted=${extractedAddress}, nftAddress=${nftAddress}`)

    if (!isEthAddress(nftAddress)) {
        return c.json({ error: 'No valid spaceId provided and AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 400)
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

        // Also fetch tax holder count
        let taxHolderCount = 0
        if (AIRDROP_TAX_PERCENT > 0 && isEthAddress(AIRDROP_TAX_NFT_ADDRESS)) {
            try {
                const taxHolders = await getMembershipNftHolderAddresses(
                    bot as AnyBot,
                    AIRDROP_TAX_NFT_ADDRESS as Address,
                )
                const taxRecipients = await getUniqueRecipientAddresses(
                    bot as AnyBot,
                    taxHolders.map((a) => a as string),
                    {
                        excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined,
                        onlyResolved: false,
                    },
                )
                taxHolderCount = taxRecipients.length
            } catch (err) {
                console.error('[Tax] Failed to fetch tax holders:', err)
            }
        }

        return c.json({
            count: uniqueRecipients.length,
            nftAddress,
            taxHolderCount,
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
        const { airdropType, totalAmount, creatorAddress, currency, spaceId, currencyDecimals: rawDecimals } = body

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

        if (airdropType === 'space') {
            // Use spaceId from miniapp context as the membership NFT contract
            // The spaceId may be a raw address or an encoded Towns stream ID
            // Fall back to env variable for backward compat
            const extractedAddress = spaceId ? extractAddressFromStreamId(spaceId) : null
            const nftAddress = extractedAddress
                || (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()

            console.log(`[Airdrop] spaceId=${spaceId}, extracted=${extractedAddress}, nftAddress=${nftAddress}`)

            if (!isEthAddress(nftAddress)) {
                return c.json({ error: 'No valid spaceId provided and AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 400)
            }

            spaceNftAddress = nftAddress

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

            recipientCount = participants.length
        }
        // For 'public' airdrops, participants join later

        // Pre-fetch tax holders so they're ready at distribution time
        let taxHolders: string[] = []
        if (AIRDROP_TAX_PERCENT > 0 && isEthAddress(AIRDROP_TAX_NFT_ADDRESS)) {
            try {
                console.log('[Tax] Pre-fetching tax holders at airdrop creation...')
                const rawTaxHolders = await getMembershipNftHolderAddresses(
                    bot as AnyBot,
                    AIRDROP_TAX_NFT_ADDRESS as Address,
                )
                taxHolders = (
                    await getUniqueRecipientAddresses(
                        bot as AnyBot,
                        rawTaxHolders.map((a) => a as string),
                        {
                            excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined,
                            onlyResolved: false,
                        },
                    )
                ).map((a) => a as string)
                console.log(`[Tax] Pre-fetched ${taxHolders.length} tax holders`)
            } catch (err) {
                console.error('[Tax] Failed to pre-fetch tax holders:', err)
            }
        }

        const totalBigInt = BigInt(totalAmount)
        const { taxAmount, netAmount } = computeTax(totalBigInt)
        const amountPer = recipientCount > 0 ? netAmount / BigInt(recipientCount) : 0n

        const airdrop: Airdrop = {
            id: generateId(),
            creatorAddress,
            airdropType,
            spaceNftAddress,
            currency: tokenAddress,
            currencyDecimals: typeof rawDecimals === 'number' ? rawDecimals : 18,
            totalAmount,
            taxPercent: AIRDROP_TAX_PERCENT,
            taxAmount: taxAmount.toString(),
            netAmount: netAmount.toString(),
            amountPerRecipient: amountPer.toString(),
            recipientCount,
            status: 'pending',
            participants,
            taxHolders,
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

// Request deposit via Towns interaction (sends tx prompt to user in channel)
app.post('/api/airdrop/:id/request-deposit', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
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
        await (bot as any).sendInteractionRequest(channelId, {
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

        return c.json({ ok: true, message: 'Transaction request sent. Approve it in your Towns chat.' })
    } catch (err) {
        console.error('[Deposit] Failed to send interaction request:', err)
        return c.json({ error: 'Failed to send transaction request: ' + (err instanceof Error ? err.message : String(err)) }, 500)
    }
})

// Confirm deposit (manual tx hash fallback)
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

        // Space airdrops auto-distribute once funded
        if (airdrop.airdropType === 'space' && airdrop.participants.length > 0) {
            airdrop.status = 'distributing'
            runDistribution(airdrop).catch(console.error)
        }

        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to confirm deposit:', err)
        return c.json({ error: 'Failed to confirm deposit' }, 500)
    }
})

// Join airdrop (public only)
// Stores mapping of wallet → display name for UI
const participantNames = new Map<string, string>() // walletAddress → displayName

app.post('/api/airdrop/:id/join', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }

    if (airdrop.airdropType !== 'public') {
        return c.json({ error: 'Cannot join a space-members airdrop' }, 400)
    }

    if (airdrop.status !== 'funded') {
        return c.json({ error: 'Airdrop not accepting participants' }, 400)
    }

    try {
        const body = await c.req.json()
        const { userAddress, userId, displayName } = body

        // Accept either the smart wallet address directly or resolve from userId
        let walletAddress = ''

        if (userAddress && isEthAddress(userAddress)) {
            walletAddress = userAddress.toLowerCase()
        } else if (userId && isEthAddress(userId)) {
            // Resolve userId to smart wallet address
            try {
                const smartAccount = await getSmartAccountFromUserId(bot as AnyBot, { userId })
                walletAddress = (smartAccount as string).toLowerCase()
                console.log(`[Join] Resolved userId ${userId} to wallet ${walletAddress}`)
            } catch (err) {
                console.error(`[Join] Failed to resolve userId ${userId}:`, err)
                return c.json({ error: 'Failed to resolve wallet address' }, 500)
            }
        } else {
            return c.json({ error: 'Missing userAddress or userId' }, 400)
        }

        // Store display name
        if (displayName) {
            participantNames.set(walletAddress, displayName)
        }

        if (!airdrop.participants.includes(walletAddress)) {
            airdrop.participants.push(walletAddress)
            airdrop.recipientCount = airdrop.participants.length

            // Recalculate per-recipient using net amount (after tax)
            const net = BigInt(airdrop.netAmount)
            airdrop.amountPerRecipient = (
                net / BigInt(airdrop.recipientCount)
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

// List public airdrops (joinable)
app.get('/api/public-airdrops', (c) => {
    const publicDrops = [...airdrops.values()]
        .filter((a) => a.airdropType === 'public' && a.status !== 'cancelled')
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(airdropToResponse)
    return c.json(publicDrops)
})

// List airdrops created by a specific user
app.get('/api/my-airdrops/:address', (c) => {
    const addr = c.req.param('address').toLowerCase()
    const myDrops = [...airdrops.values()]
        .filter((a) => a.creatorAddress.toLowerCase() === addr)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(airdropToResponse)
    return c.json(myDrops)
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
