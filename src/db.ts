/**
 * Persistent SQLite database layer using Bun's built-in bun:sqlite.
 *
 * Database file lives on Render's persistent disk (/var/data) in production,
 * or in ./data/ locally for development.
 */

import { Database } from 'bun:sqlite'

// ============================================================================
// Types (shared with index.ts)
// ============================================================================

export type AirdropStatus = 'pending' | 'funded' | 'distributing' | 'completed' | 'cancelled'

export interface Airdrop {
    id: string
    creatorAddress: string
    airdropType: 'space' | 'public'
    spaceNftAddress?: string
    currency: string
    currencySymbol: string
    currencyDecimals: number
    totalAmount: string
    taxPercent: number
    taxAmount: string
    netAmount: string
    amountPerRecipient: string
    recipientCount: number
    status: AirdropStatus
    participants: string[]
    taxHolders: string[]
    depositTxHash?: string
    distributionTxHash?: string
    taxDistributionTxHash?: string
    createdAt: number
    updatedAt: number
}

// ============================================================================
// Database row type (flat — arrays stored as JSON text)
// ============================================================================

interface AirdropRow {
    id: string
    creator_address: string
    airdrop_type: string
    space_nft_address: string | null
    currency: string
    currency_symbol: string
    currency_decimals: number
    total_amount: string
    tax_percent: number
    tax_amount: string
    net_amount: string
    amount_per_recipient: string
    recipient_count: number
    status: string
    participants: string
    tax_holders: string
    deposit_tx_hash: string | null
    distribution_tx_hash: string | null
    tax_distribution_tx_hash: string | null
    created_at: number
    updated_at: number
}

// ============================================================================
// Module state
// ============================================================================

let db: Database

// ============================================================================
// Initialisation
// ============================================================================

export function initDb(): void {
    const dbPath = process.env.DB_PATH || '/var/data/airdrop-bot.db'

    // Ensure parent directory exists
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    if (dir) {
        try {
            const { mkdirSync } = require('node:fs')
            mkdirSync(dir, { recursive: true })
        } catch {
            // directory may already exist
        }
    }

    db = new Database(dbPath)

    // Enable WAL mode for better concurrent read performance
    db.run('PRAGMA journal_mode = WAL')

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS airdrops (
            id                       TEXT PRIMARY KEY,
            creator_address          TEXT NOT NULL,
            airdrop_type             TEXT NOT NULL,
            space_nft_address        TEXT,
            currency                 TEXT NOT NULL,
            currency_symbol          TEXT NOT NULL DEFAULT '',
            currency_decimals        INTEGER NOT NULL DEFAULT 18,
            total_amount             TEXT NOT NULL,
            tax_percent              REAL NOT NULL DEFAULT 0,
            tax_amount               TEXT NOT NULL DEFAULT '0',
            net_amount               TEXT NOT NULL,
            amount_per_recipient     TEXT NOT NULL,
            recipient_count          INTEGER NOT NULL DEFAULT 0,
            status                   TEXT NOT NULL DEFAULT 'pending',
            participants             TEXT NOT NULL DEFAULT '[]',
            tax_holders              TEXT NOT NULL DEFAULT '[]',
            deposit_tx_hash          TEXT,
            distribution_tx_hash     TEXT,
            tax_distribution_tx_hash TEXT,
            created_at               INTEGER NOT NULL,
            updated_at               INTEGER NOT NULL
        )
    `)

    db.run(`
        CREATE TABLE IF NOT EXISTS participant_names (
            address      TEXT PRIMARY KEY,
            display_name TEXT NOT NULL
        )
    `)

    console.log(`[DB] SQLite database opened at ${dbPath}`)
}

// ============================================================================
// Mapping helpers (row ↔ Airdrop)
// ============================================================================

function rowToAirdrop(row: AirdropRow): Airdrop {
    return {
        id: row.id,
        creatorAddress: row.creator_address,
        airdropType: row.airdrop_type as 'space' | 'public',
        spaceNftAddress: row.space_nft_address ?? undefined,
        currency: row.currency,
        currencySymbol: row.currency_symbol,
        currencyDecimals: row.currency_decimals,
        totalAmount: row.total_amount,
        taxPercent: row.tax_percent,
        taxAmount: row.tax_amount,
        netAmount: row.net_amount,
        amountPerRecipient: row.amount_per_recipient,
        recipientCount: row.recipient_count,
        status: row.status as AirdropStatus,
        participants: JSON.parse(row.participants),
        taxHolders: JSON.parse(row.tax_holders),
        depositTxHash: row.deposit_tx_hash ?? undefined,
        distributionTxHash: row.distribution_tx_hash ?? undefined,
        taxDistributionTxHash: row.tax_distribution_tx_hash ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

// ============================================================================
// Airdrop CRUD
// ============================================================================

const SAVE_SQL = `
    INSERT OR REPLACE INTO airdrops (
        id, creator_address, airdrop_type, space_nft_address,
        currency, currency_symbol, currency_decimals,
        total_amount, tax_percent, tax_amount, net_amount,
        amount_per_recipient, recipient_count, status,
        participants, tax_holders,
        deposit_tx_hash, distribution_tx_hash, tax_distribution_tx_hash,
        created_at, updated_at
    ) VALUES (
        $id, $creator_address, $airdrop_type, $space_nft_address,
        $currency, $currency_symbol, $currency_decimals,
        $total_amount, $tax_percent, $tax_amount, $net_amount,
        $amount_per_recipient, $recipient_count, $status,
        $participants, $tax_holders,
        $deposit_tx_hash, $distribution_tx_hash, $tax_distribution_tx_hash,
        $created_at, $updated_at
    )
`

export function saveAirdrop(a: Airdrop): void {
    db.run(SAVE_SQL, {
        $id: a.id,
        $creator_address: a.creatorAddress,
        $airdrop_type: a.airdropType,
        $space_nft_address: a.spaceNftAddress ?? null,
        $currency: a.currency,
        $currency_symbol: a.currencySymbol,
        $currency_decimals: a.currencyDecimals,
        $total_amount: a.totalAmount,
        $tax_percent: a.taxPercent,
        $tax_amount: a.taxAmount,
        $net_amount: a.netAmount,
        $amount_per_recipient: a.amountPerRecipient,
        $recipient_count: a.recipientCount,
        $status: a.status,
        $participants: JSON.stringify(a.participants),
        $tax_holders: JSON.stringify(a.taxHolders),
        $deposit_tx_hash: a.depositTxHash ?? null,
        $distribution_tx_hash: a.distributionTxHash ?? null,
        $tax_distribution_tx_hash: a.taxDistributionTxHash ?? null,
        $created_at: a.createdAt,
        $updated_at: a.updatedAt,
    })
}

export function getAirdrop(id: string): Airdrop | null {
    const row = db.query('SELECT * FROM airdrops WHERE id = $id').get({ $id: id }) as AirdropRow | null
    return row ? rowToAirdrop(row) : null
}

export function updateAirdrop(id: string, fields: Partial<Airdrop>): void {
    // Build a targeted UPDATE from the provided fields
    const mapping: Record<string, { col: string; val: unknown }> = {}

    if (fields.status !== undefined) mapping.status = { col: 'status', val: fields.status }
    if (fields.depositTxHash !== undefined) mapping.depositTxHash = { col: 'deposit_tx_hash', val: fields.depositTxHash }
    if (fields.distributionTxHash !== undefined) mapping.distributionTxHash = { col: 'distribution_tx_hash', val: fields.distributionTxHash }
    if (fields.taxDistributionTxHash !== undefined) mapping.taxDistributionTxHash = { col: 'tax_distribution_tx_hash', val: fields.taxDistributionTxHash }
    if (fields.participants !== undefined) {
        mapping.participants = { col: 'participants', val: JSON.stringify(fields.participants) }
        mapping.recipient_count = { col: 'recipient_count', val: fields.participants.length }
    }
    if (fields.recipientCount !== undefined && !fields.participants) {
        mapping.recipient_count = { col: 'recipient_count', val: fields.recipientCount }
    }
    if (fields.amountPerRecipient !== undefined) mapping.amountPerRecipient = { col: 'amount_per_recipient', val: fields.amountPerRecipient }
    if (fields.updatedAt !== undefined) mapping.updatedAt = { col: 'updated_at', val: fields.updatedAt }
    if (fields.taxHolders !== undefined) mapping.taxHolders = { col: 'tax_holders', val: JSON.stringify(fields.taxHolders) }

    const entries = Object.values(mapping)
    if (entries.length === 0) return

    const setClauses = entries.map((e) => `${e.col} = ?`).join(', ')
    const values = entries.map((e) => e.val)
    values.push(id) // for WHERE

    db.run(`UPDATE airdrops SET ${setClauses} WHERE id = ?`, ...values)
}

export function listPublicAirdrops(): Airdrop[] {
    const rows = db.query(
        `SELECT * FROM airdrops WHERE airdrop_type = 'public' AND status != 'cancelled' ORDER BY created_at DESC`,
    ).all() as AirdropRow[]
    return rows.map(rowToAirdrop)
}

export function listAirdropsByCreator(address: string): Airdrop[] {
    const rows = db.query(
        'SELECT * FROM airdrops WHERE LOWER(creator_address) = $addr ORDER BY created_at DESC',
    ).all({ $addr: address.toLowerCase() }) as AirdropRow[]
    return rows.map(rowToAirdrop)
}

export function getAirdropCount(): number {
    const row = db.query('SELECT COUNT(*) as cnt FROM airdrops').get() as { cnt: number }
    return row.cnt
}

// ============================================================================
// Participant names
// ============================================================================

export function setParticipantName(address: string, name: string): void {
    db.run(
        'INSERT OR REPLACE INTO participant_names (address, display_name) VALUES ($addr, $name)',
        { $addr: address.toLowerCase(), $name: name },
    )
}

export function getParticipantName(address: string): string | null {
    const row = db.query('SELECT display_name FROM participant_names WHERE address = $addr').get({
        $addr: address.toLowerCase(),
    }) as { display_name: string } | null
    return row ? row.display_name : null
}

export function getParticipantNames(addresses: string[]): Map<string, string> {
    const result = new Map<string, string>()
    if (addresses.length === 0) return result

    // Use batched queries to avoid overly long SQL
    const BATCH = 500
    for (let i = 0; i < addresses.length; i += BATCH) {
        const batch = addresses.slice(i, i + BATCH).map((a) => a.toLowerCase())
        const placeholders = batch.map(() => '?').join(',')
        const rows = db.query(
            `SELECT address, display_name FROM participant_names WHERE address IN (${placeholders})`,
        ).all(...batch) as { address: string; display_name: string }[]
        for (const row of rows) {
            result.set(row.address, row.display_name)
        }
    }
    return result
}
