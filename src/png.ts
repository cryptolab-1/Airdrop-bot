/**
 * Minimal PNG generator for solid-color images.
 * No external dependencies - uses Node's built-in zlib.
 */
import { deflateSync } from 'node:zlib'

// CRC32 lookup table
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crcInput = Buffer.concat([t, data])
    const crcVal = crc32(crcInput)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crcVal >>> 0, 0)
    return Buffer.concat([len, t, data, crc])
}

/**
 * Create a solid-color PNG image.
 */
export function createSolidPNG(width: number, height: number, r: number, g: number, b: number): Buffer {
    // PNG signature
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

    // IHDR chunk
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8   // bit depth
    ihdr[9] = 2   // color type: RGB
    ihdr[10] = 0  // compression
    ihdr[11] = 0  // filter
    ihdr[12] = 0  // interlace

    // Raw image data: filter byte (0) + RGB pixels per row
    const rowBytes = 1 + width * 3
    const raw = Buffer.alloc(rowBytes * height)
    for (let y = 0; y < height; y++) {
        const offset = y * rowBytes
        raw[offset] = 0 // filter: None
        for (let x = 0; x < width; x++) {
            const px = offset + 1 + x * 3
            raw[px] = r
            raw[px + 1] = g
            raw[px + 2] = b
        }
    }

    const compressed = deflateSync(raw, { level: 9 })

    return Buffer.concat([
        sig,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ])
}

// Pre-generate cached images (purple #7C3AED = rgb(124, 58, 237))
export const OG_IMAGE = createSolidPNG(1200, 800, 124, 58, 237)
export const SPLASH_IMAGE = createSolidPNG(200, 200, 124, 58, 237)
export const ICON_IMAGE = createSolidPNG(1024, 1024, 124, 58, 237)
