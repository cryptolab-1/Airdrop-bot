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
    taxPercent: number        // holder tax % (e.g. 2)
    taxAmount: string         // holder tax wei
    adminTaxPercent: number   // admin tax % (e.g. 1)
    adminTaxAmount: string    // admin tax wei
    netAmount: string
    amountPerRecipient: string
    recipientCount: number
    status: AirdropStatus
    participants: string[]
    taxHolders: string[]
    depositTxHash?: string
    depositInteractionEventId?: string  // eventId of the deposit interaction request (to remove after confirmation)
    depositChannelId?: string           // channelId where the deposit interaction was sent
    distributionTxHash?: string
    taxDistributionTxHash?: string
    adminTaxDistributionTxHash?: string
    title?: string
    description?: string
    maxParticipants?: number  // 0 or undefined = unlimited
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
    admin_tax_percent: number
    admin_tax_amount: string
    net_amount: string
    amount_per_recipient: string
    recipient_count: number
    status: string
    participants: string
    tax_holders: string
    deposit_tx_hash: string | null
    deposit_interaction_event_id: string | null
    deposit_channel_id: string | null
    distribution_tx_hash: string | null
    tax_distribution_tx_hash: string | null
    admin_tax_distribution_tx_hash: string | null
    title: string | null
    description: string | null
    max_participants: number | null
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
            admin_tax_percent        REAL NOT NULL DEFAULT 0,
            admin_tax_amount         TEXT NOT NULL DEFAULT '0',
            net_amount               TEXT NOT NULL,
            amount_per_recipient     TEXT NOT NULL,
            recipient_count          INTEGER NOT NULL DEFAULT 0,
            status                   TEXT NOT NULL DEFAULT 'pending',
            participants             TEXT NOT NULL DEFAULT '[]',
            tax_holders              TEXT NOT NULL DEFAULT '[]',
            deposit_tx_hash          TEXT,
            deposit_interaction_event_id TEXT,
            deposit_channel_id       TEXT,
            distribution_tx_hash     TEXT,
            tax_distribution_tx_hash TEXT,
            admin_tax_distribution_tx_hash TEXT,
            title                    TEXT,
            description              TEXT,
            max_participants         INTEGER DEFAULT 0,
            created_at               INTEGER NOT NULL,
            updated_at               INTEGER NOT NULL
        )
    `)

    // Migrate existing DB: add new columns if they don't exist
    const cols = db.query("PRAGMA table_info(airdrops)").all() as { name: string }[]
    const colNames = new Set(cols.map((c) => c.name))
    if (!colNames.has('admin_tax_percent')) {
        db.run("ALTER TABLE airdrops ADD COLUMN admin_tax_percent REAL NOT NULL DEFAULT 0")
    }
    if (!colNames.has('admin_tax_amount')) {
        db.run("ALTER TABLE airdrops ADD COLUMN admin_tax_amount TEXT NOT NULL DEFAULT '0'")
    }
    if (!colNames.has('admin_tax_distribution_tx_hash')) {
        db.run("ALTER TABLE airdrops ADD COLUMN admin_tax_distribution_tx_hash TEXT")
    }
    if (!colNames.has('title')) {
        db.run("ALTER TABLE airdrops ADD COLUMN title TEXT")
    }
    if (!colNames.has('description')) {
        db.run("ALTER TABLE airdrops ADD COLUMN description TEXT")
    }
    if (!colNames.has('max_participants')) {
        db.run("ALTER TABLE airdrops ADD COLUMN max_participants INTEGER DEFAULT 0")
    }
    if (!colNames.has('deposit_interaction_event_id')) {
        db.run("ALTER TABLE airdrops ADD COLUMN deposit_interaction_event_id TEXT")
    }
    if (!colNames.has('deposit_channel_id')) {
        db.run("ALTER TABLE airdrops ADD COLUMN deposit_channel_id TEXT")
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS participant_names (
            address      TEXT PRIMARY KEY,
            display_name TEXT NOT NULL
        )
    `)

    // Tax holders table — refreshed every 24h from blockchain
    db.run(`
        CREATE TABLE IF NOT EXISTS tax_holders (
            address    TEXT PRIMARY KEY,
            updated_at INTEGER NOT NULL
        )
    `)

    // Space NFT holders cache — refreshed every 24h per space
    db.run(`
        CREATE TABLE IF NOT EXISTS space_holders (
            nft_address    TEXT NOT NULL,
            holder_address TEXT NOT NULL,
            updated_at     INTEGER NOT NULL,
            PRIMARY KEY (nft_address, holder_address)
        )
    `)

    // Token info cache — persisted permanently (no expiry needed)
    db.run(`
        CREATE TABLE IF NOT EXISTS token_cache (
            address    TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '',
            symbol     TEXT NOT NULL DEFAULT '',
            decimals   INTEGER NOT NULL DEFAULT 18,
            created_at INTEGER NOT NULL
        )
    `)

    // User wallet mapping (userId EOA → smart wallet address)
    db.run(`
        CREATE TABLE IF NOT EXISTS user_wallets (
            user_id        TEXT PRIMARY KEY,
            wallet_address TEXT NOT NULL
        )
    `)

    // App settings (key-value store for timestamps, flags, etc.)
    db.run(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `)

    // Space name cache — persisted permanently (spaces don't rename)
    db.run(`
        CREATE TABLE IF NOT EXISTS space_names (
            nft_address TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL
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
        adminTaxPercent: row.admin_tax_percent,
        adminTaxAmount: row.admin_tax_amount,
        netAmount: row.net_amount,
        amountPerRecipient: row.amount_per_recipient,
        recipientCount: row.recipient_count,
        status: row.status as AirdropStatus,
        participants: JSON.parse(row.participants),
        taxHolders: JSON.parse(row.tax_holders),
        depositTxHash: row.deposit_tx_hash ?? undefined,
        depositInteractionEventId: row.deposit_interaction_event_id ?? undefined,
        depositChannelId: row.deposit_channel_id ?? undefined,
        distributionTxHash: row.distribution_tx_hash ?? undefined,
        taxDistributionTxHash: row.tax_distribution_tx_hash ?? undefined,
        adminTaxDistributionTxHash: row.admin_tax_distribution_tx_hash ?? undefined,
        title: row.title ?? undefined,
        description: row.description ?? undefined,
        maxParticipants: row.max_participants ?? 0,
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
        total_amount, tax_percent, tax_amount,
        admin_tax_percent, admin_tax_amount, net_amount,
        amount_per_recipient, recipient_count, status,
        participants, tax_holders,
        deposit_tx_hash, deposit_interaction_event_id, deposit_channel_id,
        distribution_tx_hash,
        tax_distribution_tx_hash, admin_tax_distribution_tx_hash,
        title, description, max_participants,
        created_at, updated_at
    ) VALUES (
        $id, $creator_address, $airdrop_type, $space_nft_address,
        $currency, $currency_symbol, $currency_decimals,
        $total_amount, $tax_percent, $tax_amount,
        $admin_tax_percent, $admin_tax_amount, $net_amount,
        $amount_per_recipient, $recipient_count, $status,
        $participants, $tax_holders,
        $deposit_tx_hash, $deposit_interaction_event_id, $deposit_channel_id,
        $distribution_tx_hash,
        $tax_distribution_tx_hash, $admin_tax_distribution_tx_hash,
        $title, $description, $max_participants,
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
        $admin_tax_percent: a.adminTaxPercent,
        $admin_tax_amount: a.adminTaxAmount,
        $net_amount: a.netAmount,
        $amount_per_recipient: a.amountPerRecipient,
        $recipient_count: a.recipientCount,
        $status: a.status,
        $participants: JSON.stringify(a.participants),
        $tax_holders: JSON.stringify(a.taxHolders),
        $deposit_tx_hash: a.depositTxHash ?? null,
        $deposit_interaction_event_id: a.depositInteractionEventId ?? null,
        $deposit_channel_id: a.depositChannelId ?? null,
        $distribution_tx_hash: a.distributionTxHash ?? null,
        $tax_distribution_tx_hash: a.taxDistributionTxHash ?? null,
        $admin_tax_distribution_tx_hash: a.adminTaxDistributionTxHash ?? null,
        $title: a.title ?? null,
        $description: a.description ?? null,
        $max_participants: a.maxParticipants ?? 0,
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
    if (fields.depositInteractionEventId !== undefined) mapping.depositInteractionEventId = { col: 'deposit_interaction_event_id', val: fields.depositInteractionEventId }
    if (fields.depositChannelId !== undefined) mapping.depositChannelId = { col: 'deposit_channel_id', val: fields.depositChannelId }
    if (fields.distributionTxHash !== undefined) mapping.distributionTxHash = { col: 'distribution_tx_hash', val: fields.distributionTxHash }
    if (fields.taxDistributionTxHash !== undefined) mapping.taxDistributionTxHash = { col: 'tax_distribution_tx_hash', val: fields.taxDistributionTxHash }
    if (fields.adminTaxDistributionTxHash !== undefined) mapping.adminTaxDistributionTxHash = { col: 'admin_tax_distribution_tx_hash', val: fields.adminTaxDistributionTxHash }
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
    if (fields.title !== undefined) mapping.title = { col: 'title', val: fields.title }
    if (fields.description !== undefined) mapping.description = { col: 'description', val: fields.description }

    const entries = Object.values(mapping)
    if (entries.length === 0) return

    const setClauses = entries.map((e) => `${e.col} = ?`).join(', ')
    const values = entries.map((e) => e.val)
    values.push(id) // for WHERE

    db.run(`UPDATE airdrops SET ${setClauses} WHERE id = ?`, ...values)
}

export function listPublicAirdrops(): Airdrop[] {
    const rows = db.query(
        `SELECT * FROM airdrops
         WHERE (airdrop_type = 'public' OR (airdrop_type = 'space' AND max_participants > 0))
           AND status IN ('pending','funded')
         ORDER BY created_at DESC`,
    ).all() as AirdropRow[]
    return rows.map(rowToAirdrop)
}

export function listAirdropsByCreator(address: string): Airdrop[] {
    const rows = db.query(
        'SELECT * FROM airdrops WHERE LOWER(creator_address) = $addr ORDER BY created_at DESC',
    ).all({ $addr: address.toLowerCase() }) as AirdropRow[]
    return rows.map(rowToAirdrop)
}

export function listAirdropHistory(): Airdrop[] {
    // All airdrops except joinable ones that are still pending/funded (those stay in "Join" screen)
    const rows = db.query(`
        SELECT * FROM airdrops
        WHERE NOT (airdrop_type = 'public' AND status IN ('pending','funded'))
          AND NOT (airdrop_type = 'space' AND max_participants > 0 AND status IN ('pending','funded'))
        ORDER BY created_at DESC
        LIMIT 100
    `).all() as AirdropRow[]
    return rows.map(rowToAirdrop)
}

export function getAirdropCount(): number {
    const row = db.query('SELECT COUNT(*) as cnt FROM airdrops').get() as { cnt: number }
    return row.cnt
}

/** Delete an airdrop by ID */
export function deleteAirdrop(id: string): void {
    db.run('DELETE FROM airdrops WHERE id = $id', { $id: id })
}

/** Reset leaderboard by setting a cutoff timestamp (airdrops before this are excluded) */
export function resetLeaderboard(): void {
    db.run(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('leaderboard_reset_at', $ts)",
        { $ts: String(Date.now()) },
    )
}

/** Get the leaderboard reset cutoff timestamp (0 if never reset) */
export function getLeaderboardResetAt(): number {
    const row = db.query(
        "SELECT value FROM app_settings WHERE key = 'leaderboard_reset_at'",
    ).get() as { value: string } | null
    return row ? parseInt(row.value, 10) : 0
}

/** Delete all airdrops in history view (everything except public pending/funded) */
export function deleteHistoryAirdrops(): number {
    const result = db.run("DELETE FROM airdrops WHERE NOT (airdrop_type = 'public' AND status IN ('pending','funded'))")
    return result.changes
}

// ============================================================================
// Leaderboard queries
// ============================================================================

interface LeaderboardEntry {
    address: string
    count: number
    totalAmount: string
}

interface SpaceLeaderboardEntry {
    spaceNftAddress: string
    spaceName: string | null
    count: number
    totalAmount: string
}

/** Top N users who received the most airdrops (appeared as participants). */
export function getTopRecipients(limit = 5): LeaderboardEntry[] {
    const cutoff = getLeaderboardResetAt()
    const rows = db.query(`
        SELECT j.value AS address,
               COUNT(DISTINCT a.id) AS count
        FROM airdrops a, json_each(a.participants) j
        WHERE a.status = 'completed'
          AND a.created_at > $cutoff
        GROUP BY LOWER(j.value)
        ORDER BY count DESC
        LIMIT $limit
    `).all({ $limit: limit, $cutoff: cutoff }) as { address: string; count: number }[]

    return rows.map(r => ({
        address: r.address,
        count: r.count,
        totalAmount: '0',
    }))
}

/** Top N airdrop creators by number of completed airdrops. */
export function getTopCreators(limit = 5): LeaderboardEntry[] {
    const cutoff = getLeaderboardResetAt()
    const rows = db.query(`
        SELECT creator_address AS address,
               COUNT(*) AS count
        FROM airdrops
        WHERE status = 'completed'
          AND created_at > $cutoff
        GROUP BY LOWER(creator_address)
        ORDER BY count DESC
        LIMIT $limit
    `).all({ $limit: limit, $cutoff: cutoff }) as { address: string; count: number }[]

    return rows.map(r => ({
        address: r.address,
        count: r.count,
        totalAmount: '0',
    }))
}

/** Top N spaces (by NFT address) that received the most airdrops. */
export function getTopSpaces(limit = 5): SpaceLeaderboardEntry[] {
    const cutoff = getLeaderboardResetAt()
    const rows = db.query(`
        SELECT a.space_nft_address,
               sn.name AS space_name,
               COUNT(*) AS count
        FROM airdrops a
        LEFT JOIN space_names sn ON LOWER(a.space_nft_address) = LOWER(sn.nft_address)
        WHERE a.status = 'completed'
          AND a.created_at > $cutoff
          AND a.space_nft_address IS NOT NULL
          AND a.space_nft_address != ''
        GROUP BY LOWER(a.space_nft_address)
        ORDER BY count DESC
        LIMIT $limit
    `).all({ $limit: limit, $cutoff: cutoff }) as { space_nft_address: string; space_name: string | null; count: number; total_amount: number | null }[]

    return rows.map(r => ({
        spaceNftAddress: r.space_nft_address,
        spaceName: r.space_name || null,
        count: r.count,
        totalAmount: '0',
    }))
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

// ============================================================================
// User wallet mapping (userId EOA → smart wallet)
// ============================================================================

export function setUserWallet(userId: string, walletAddress: string): void {
    db.run(
        'INSERT OR REPLACE INTO user_wallets (user_id, wallet_address) VALUES ($uid, $wallet)',
        { $uid: userId.toLowerCase(), $wallet: walletAddress.toLowerCase() },
    )
}

export function getUserWallet(userId: string): string | null {
    const row = db.query('SELECT wallet_address FROM user_wallets WHERE user_id = $uid').get({
        $uid: userId.toLowerCase(),
    }) as { wallet_address: string } | null
    return row?.wallet_address ?? null
}

export function getUserWallets(userIds: string[]): Map<string, string> {
    const result = new Map<string, string>()
    if (userIds.length === 0) return result
    const batch = userIds.map(u => u.toLowerCase())
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.query(
        `SELECT user_id, wallet_address FROM user_wallets WHERE user_id IN (${placeholders})`,
    ).all(...batch) as { user_id: string; wallet_address: string }[]
    for (const row of rows) {
        result.set(row.user_id, row.wallet_address)
    }
    return result
}

/** Reverse lookup: find userIds (EOAs) for a list of smart wallet addresses */
export function getUserIdsByWallets(walletAddresses: string[]): Map<string, string> {
    const result = new Map<string, string>() // wallet → userId
    if (walletAddresses.length === 0) return result
    const BATCH = 500
    for (let i = 0; i < walletAddresses.length; i += BATCH) {
        const batch = walletAddresses.slice(i, i + BATCH).map(a => a.toLowerCase())
        const placeholders = batch.map(() => '?').join(',')
        const rows = db.query(
            `SELECT user_id, wallet_address FROM user_wallets WHERE wallet_address IN (${placeholders})`,
        ).all(...batch) as { user_id: string; wallet_address: string }[]
        for (const row of rows) {
            result.set(row.wallet_address, row.user_id)
        }
    }
    return result
}

// ============================================================================
// Tax holders (persisted, refreshed every 24h)
// ============================================================================

export function saveTaxHolders(addresses: string[]): void {
    const now = Date.now()
    const tx = db.transaction(() => {
        db.run('DELETE FROM tax_holders')
        const stmt = db.prepare('INSERT INTO tax_holders (address, updated_at) VALUES ($addr, $ts)')
        for (const addr of addresses) {
            stmt.run({ $addr: addr.toLowerCase(), $ts: now })
        }
    })
    tx()
}

export function getTaxHolders(): string[] {
    const rows = db.query('SELECT address FROM tax_holders').all() as { address: string }[]
    return rows.map((r) => r.address)
}

export function getTaxHolderCount(): number {
    const row = db.query('SELECT COUNT(*) as cnt FROM tax_holders').get() as { cnt: number }
    return row.cnt
}

export function getTaxHoldersLastUpdated(): number | null {
    const row = db.query('SELECT MAX(updated_at) as ts FROM tax_holders').get() as { ts: number | null }
    return row?.ts ?? null
}

// ============================================================================
// Space NFT holders cache (per space, refreshed every 24h)
// ============================================================================

const SPACE_HOLDER_REFRESH_MS = 24 * 60 * 60 * 1000 // 24h

export function saveSpaceHolders(nftAddress: string, holders: string[]): void {
    const now = Date.now()
    const addr = nftAddress.toLowerCase()
    const tx = db.transaction(() => {
        db.run('DELETE FROM space_holders WHERE nft_address = $addr', { $addr: addr })
        const stmt = db.prepare(
            'INSERT INTO space_holders (nft_address, holder_address, updated_at) VALUES ($nft, $holder, $ts)',
        )
        for (const h of holders) {
            stmt.run({ $nft: addr, $holder: h.toLowerCase(), $ts: now })
        }
    })
    tx()
}

export function getSpaceHolders(nftAddress: string): string[] | null {
    const addr = nftAddress.toLowerCase()
    const rows = db.query(
        'SELECT holder_address FROM space_holders WHERE nft_address = $addr',
    ).all({ $addr: addr }) as { holder_address: string }[]
    if (rows.length === 0) return null
    return rows.map((r) => r.holder_address)
}

export function getSpaceHoldersLastUpdated(nftAddress: string): number | null {
    const addr = nftAddress.toLowerCase()
    const row = db.query(
        'SELECT MAX(updated_at) as ts FROM space_holders WHERE nft_address = $addr',
    ).get({ $addr: addr }) as { ts: number | null }
    return row?.ts ?? null
}

export function isSpaceHoldersStale(nftAddress: string): boolean {
    const lastUpdated = getSpaceHoldersLastUpdated(nftAddress)
    if (!lastUpdated) return true
    return Date.now() - lastUpdated > SPACE_HOLDER_REFRESH_MS
}

// ============================================================================
// Token info cache (permanent — no expiry)
// ============================================================================

export interface CachedTokenInfo {
    address: string
    name: string
    symbol: string
    decimals: number
}

export function saveTokenInfo(address: string, name: string, symbol: string, decimals: number): void {
    db.run(
        `INSERT OR REPLACE INTO token_cache (address, name, symbol, decimals, created_at)
         VALUES ($addr, $name, $symbol, $decimals, $ts)`,
        {
            $addr: address.toLowerCase(),
            $name: name,
            $symbol: symbol,
            $decimals: decimals,
            $ts: Date.now(),
        },
    )
}

export function getTokenInfo(address: string): CachedTokenInfo | null {
    const row = db.query(
        'SELECT address, name, symbol, decimals FROM token_cache WHERE address = $addr',
    ).get({ $addr: address.toLowerCase() }) as { address: string; name: string; symbol: string; decimals: number } | null
    return row ?? null
}

// ============================================================================
// Space name cache (permanent — spaces don't rename)
// ============================================================================

export function saveSpaceName(nftAddress: string, name: string): void {
    db.run(
        `INSERT OR REPLACE INTO space_names (nft_address, name, created_at)
         VALUES ($addr, $name, $ts)`,
        {
            $addr: nftAddress.toLowerCase(),
            $name: name,
            $ts: Date.now(),
        },
    )
}

export function getSpaceName(nftAddress: string): string | null {
    const row = db.query(
        'SELECT name FROM space_names WHERE nft_address = $addr',
    ).get({ $addr: nftAddress.toLowerCase() }) as { name: string } | null
    return row?.name ?? null
}
