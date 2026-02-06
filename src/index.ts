/**
 * $TOWNS Airdrop Bot + Mini App
 * 
 * Slash command /drop opens the mini app UI for airdrop management.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { makeTownsBot } from '@towns-protocol/bot'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import type { Address } from 'viem'
import { erc20Abi } from 'viem'
import { execute as executeErc7821 } from 'viem/experimental/erc7821'
import { supportsExecutionMode } from 'viem/experimental/erc7821'
import commands from './commands'
import {
    TOWNS_ADDRESS,
    type AnyBot,
    formatEther,
    parseEther,
    getMembershipNftHolderAddresses,
    isEthAddress,
    getUniqueRecipientAddresses,
    chunkRecipients,
} from './airdrop'
import { generateManifest, generateEmbedMeta } from './manifest'

// Initialize bot with slash commands
const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

const MINIAPP_URL = process.env.MINIAPP_URL || 'https://airdrop.example.com'

// ============================================================================
// Slash Commands - Entry point to Mini App
// ============================================================================

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**$TOWNS Airdrop Bot**\n\n' +
        '• `/drop` - Open the airdrop mini app\n' +
        '• `/drop <amount>` - Quick fixed airdrop to all NFT holders\n' +
        '• `/drop react <amount>` - Create react-to-join airdrop\n\n' +
        'The mini app provides a visual interface for creating and managing airdrops.',
    )
})

bot.onSlashCommand('drop', async (handler, event) => {
    const { channelId, userId, args, spaceId, isDm } = event
    
    if (isDm) {
        await handler.sendMessage(channelId, 'Use `/drop` in a space channel.')
        return
    }

    // If no arguments, open the mini app
    if (args.length === 0) {
        await handler.sendMessage(
            channelId,
            `**$TOWNS Airdrop** - Click to open: ${MINIAPP_URL}`,
            {
                attachments: [
                    {
                        type: 'link',
                        url: MINIAPP_URL,
                    },
                ],
                mentions: [{ userId, displayName: 'Creator' }],
            },
        )
        return
    }

    // Quick drop with amount specified
    const first = args[0]?.toLowerCase()
    const isReact = first === 'react'
    const amountStr = isReact ? args[1] : args[0]
    
    if (!amountStr) {
        await handler.sendMessage(
            channelId,
            'Usage:\n• `/drop` - Open mini app\n• `/drop <amount>` - Quick fixed drop\n• `/drop react <amount>` - React-to-join drop',
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

    // For quick drops, open mini app with pre-filled amount
    const mode = isReact ? 'react' : 'fixed'
    const appUrl = `${MINIAPP_URL}?amount=${amount}&mode=${mode}`
    
    await handler.sendMessage(
        channelId,
        `**$TOWNS Airdrop** - ${formatEther(parseEther(amount.toString()))} $TOWNS ${isReact ? '(react mode)' : '(fixed)'}\n\nOpen: ${appUrl}`,
        {
            attachments: [
                {
                    type: 'link',
                    url: appUrl,
                },
            ],
            mentions: [{ userId, displayName: 'Creator' }],
        },
    )
})

// ============================================================================
// Types
// ============================================================================

export type AirdropStatus = 'pending' | 'funded' | 'distributing' | 'completed' | 'cancelled'

export type Airdrop = {
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

// In-memory store (in production, use a database)
const airdrops = new Map<string, Airdrop>()

// WebSocket connections per airdrop
const wsConnections = new Map<string, Set<WebSocket>>()

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
    return `airdrop_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function broadcastAirdropUpdate(airdropId: string, airdrop: Airdrop) {
    const connections = wsConnections.get(airdropId)
    if (!connections) return
    
    const message = JSON.stringify({
        type: 'airdrop_update',
        airdrop: airdropToResponse(airdrop),
    })
    
    for (const ws of connections) {
        try {
            ws.send(message)
        } catch {
            connections.delete(ws)
        }
    }
}

function airdropToResponse(airdrop: Airdrop) {
    return {
        id: airdrop.id,
        creatorAddress: airdrop.creatorAddress,
        totalAmount: airdrop.totalAmount,
        amountPerRecipient: airdrop.amountPerRecipient,
        recipientCount: airdrop.recipientCount,
        status: airdrop.status,
        participants: airdrop.participants,
        txHash: airdrop.distributionTxHash || airdrop.depositTxHash,
    }
}

const DISTRIBUTION_RETRIES = Math.max(1, Math.min(10, parseInt(process.env.AIRDROP_DISTRIBUTION_RETRIES ?? '4', 10) || 4))
const DISTRIBUTION_RETRY_DELAY_MS = Math.max(500, parseInt(process.env.AIRDROP_DISTRIBUTION_RETRY_DELAY_MS ?? '2000', 10) || 2000)

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

async function runBotDistribution(
    recipients: Address[],
    amountPer: bigint,
    _totalRaw: bigint,
    fromAddress: Address
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
    const treasury = bot.appAddress as Address | undefined
    const account = (bot.viem as { account?: { address: Address } }).account
    if (!treasury || fromAddress.toLowerCase() !== treasury.toLowerCase() || !account) {
        return { ok: false, error: 'Distribution only supported from bot treasury (bot.appAddress).' }
    }
    const batches = chunkRecipients(recipients)
    let lastHash: string | undefined
    
    for (let attempt = 0; attempt < DISTRIBUTION_RETRIES; attempt++) {
        try {
            const ok = await supportsExecutionMode(bot.viem, { address: treasury })
            if (!ok) {
                if (attempt < DISTRIBUTION_RETRIES - 1) {
                    await sleep(DISTRIBUTION_RETRY_DELAY_MS)
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
                await sleep(DISTRIBUTION_RETRY_DELAY_MS)
                continue
            }
            return { ok: false, error: err }
        }
    }
    return { ok: false, error: 'Treasury does not support ERC-7821 execute().' }
}

// ============================================================================
// Hono App for API + Static Files
// ============================================================================

const honoApp = new Hono()

// CORS for mini app
honoApp.use('/api/*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type'],
}))

// ============================================================================
// Manifest Endpoints
// ============================================================================

honoApp.get('/.well-known/farcaster.json', (c) => {
    return c.json(generateManifest())
})

honoApp.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

honoApp.get('/embed-meta', (c) => {
    return c.json(generateEmbedMeta())
})

// ============================================================================
// API Routes
// ============================================================================

// Get NFT holder count
honoApp.get('/api/holders', async (c) => {
    const nftAddress = (process.env.AIRDROP_MEMBERSHIP_NFT_ADDRESS ?? '').trim()
    
    if (!isEthAddress(nftAddress)) {
        return c.json({ error: 'AIRDROP_MEMBERSHIP_NFT_ADDRESS not configured' }, 500)
    }
    
    try {
        const holders = await getMembershipNftHolderAddresses(bot as AnyBot, nftAddress as Address)
        const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        
        const uniqueRecipients = await getUniqueRecipientAddresses(
            bot as AnyBot,
            holders.map((a) => a as string),
            { excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined, onlyResolved: false }
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
honoApp.post('/api/airdrop', async (c) => {
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
            const holders = await getMembershipNftHolderAddresses(bot as AnyBot, nftAddress as Address)
            const excludeAddresses = (process.env.AIRDROP_EXCLUDE_ADDRESSES ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            
            participants = (await getUniqueRecipientAddresses(
                bot as AnyBot,
                holders.map((a) => a as string),
                { excludeAddresses: excludeAddresses.length > 0 ? excludeAddresses : undefined, onlyResolved: false }
            )).map(a => a as string)
            
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
honoApp.get('/api/airdrop/:id', (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }
    return c.json(airdropToResponse(airdrop))
})

// Confirm deposit
honoApp.post('/api/airdrop/:id/confirm-deposit', async (c) => {
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
        
        const receipt = await waitForTransactionReceipt(bot.viem, { hash: txHash as `0x${string}` })
        
        if (receipt.status !== 'success') {
            return c.json({ error: 'Transaction failed on-chain' }, 400)
        }
        
        airdrop.depositTxHash = txHash
        airdrop.status = 'funded'
        airdrop.updatedAt = Date.now()
        
        if (airdrop.mode === 'fixed' && airdrop.participants.length > 0) {
            airdrop.status = 'distributing'
            broadcastAirdropUpdate(airdrop.id, airdrop)
            runDistribution(airdrop).catch(console.error)
        } else {
            broadcastAirdropUpdate(airdrop.id, airdrop)
        }
        
        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to confirm deposit:', err)
        return c.json({ error: 'Failed to confirm deposit' }, 500)
    }
})

// Join airdrop (react mode)
honoApp.post('/api/airdrop/:id/join', async (c) => {
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
            airdrop.amountPerRecipient = (totalBigInt / BigInt(airdrop.recipientCount)).toString()
            airdrop.updatedAt = Date.now()
            
            broadcastAirdropUpdate(airdrop.id, airdrop)
        }
        
        return c.json(airdropToResponse(airdrop))
    } catch (err) {
        console.error('Failed to join airdrop:', err)
        return c.json({ error: 'Failed to join airdrop' }, 500)
    }
})

// Launch airdrop (react mode)
honoApp.post('/api/airdrop/:id/launch', async (c) => {
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
    broadcastAirdropUpdate(airdrop.id, airdrop)
    
    runDistribution(airdrop).catch(console.error)
    
    return c.json(airdropToResponse(airdrop))
})

// Cancel airdrop
honoApp.post('/api/airdrop/:id/cancel', async (c) => {
    const airdrop = airdrops.get(c.req.param('id'))
    if (!airdrop) {
        return c.json({ error: 'Airdrop not found' }, 404)
    }
    
    if (airdrop.status === 'completed' || airdrop.status === 'distributing') {
        return c.json({ error: 'Cannot cancel airdrop in current state' }, 400)
    }
    
    airdrop.status = 'cancelled'
    airdrop.updatedAt = Date.now()
    broadcastAirdropUpdate(airdrop.id, airdrop)
    
    return c.json(airdropToResponse(airdrop))
})

// Distribution helper
async function runDistribution(airdrop: Airdrop) {
    const botAddress = bot.appAddress as Address
    const amountPer = BigInt(airdrop.amountPerRecipient)
    const totalRaw = BigInt(airdrop.totalAmount)
    const recipients = airdrop.participants.map(a => a as Address)
    
    const result = await runBotDistribution(recipients, amountPer, totalRaw, botAddress)
    
    if (result.ok) {
        airdrop.status = 'completed'
        airdrop.distributionTxHash = result.txHash
    } else {
        airdrop.status = 'funded'
        console.error('Distribution failed:', result.error)
    }
    
    airdrop.updatedAt = Date.now()
    broadcastAirdropUpdate(airdrop.id, airdrop)
}

// ============================================================================
// Static Files (for production)
// ============================================================================

honoApp.use('/*', serveStatic({ root: './miniapp/dist' }))
honoApp.get('*', serveStatic({ path: './miniapp/dist/index.html' }))

// ============================================================================
// Start Bot + Extend with Hono routes
// ============================================================================

const app = bot.start()

// Mount Hono routes onto the bot's app
app.route('/', honoApp)

// Export Bun server configuration
// hostname 0.0.0.0 is required for cloud deployments (Render, etc.)
export default {
    port: parseInt(process.env.PORT ?? '3000', 10),
    hostname: '0.0.0.0',
    fetch: app.fetch,
}
