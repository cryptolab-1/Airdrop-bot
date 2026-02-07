/**
 * Minimal PNG generator for solid-color images.
 * Uses Uint8Array for Bun compatibility.
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

function crc32(data: Uint8Array): number {
    let c = 0xffffffff
    for (let i = 0; i < data.length; i++) {
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function writeUint32BE(arr: Uint8Array, value: number, offset: number) {
    arr[offset] = (value >>> 24) & 0xff
    arr[offset + 1] = (value >>> 16) & 0xff
    arr[offset + 2] = (value >>> 8) & 0xff
    arr[offset + 3] = value & 0xff
}

function concat(...arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0
    for (const arr of arrays) totalLength += arr.length
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const arr of arrays) {
        result.set(arr, offset)
        offset += arr.length
    }
    return result
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const len = new Uint8Array(4)
    writeUint32BE(len, data.length, 0)

    const t = new TextEncoder().encode(type)
    const crcInput = concat(t, data)
    const crcVal = crc32(crcInput)
    const crc = new Uint8Array(4)
    writeUint32BE(crc, crcVal, 0)

    return concat(len, t, data, crc)
}

/**
 * Create a solid-color PNG image.
 */
export function createSolidPNG(width: number, height: number, r: number, g: number, b: number): Uint8Array {
    // PNG signature
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

    // IHDR chunk (13 bytes)
    const ihdr = new Uint8Array(13)
    writeUint32BE(ihdr, width, 0)
    writeUint32BE(ihdr, height, 4)
    ihdr[8] = 8   // bit depth
    ihdr[9] = 2   // color type: RGB
    ihdr[10] = 0  // compression
    ihdr[11] = 0  // filter
    ihdr[12] = 0  // interlace

    // Raw image data: filter byte (0) + RGB pixels per row
    const rowBytes = 1 + width * 3
    const raw = new Uint8Array(rowBytes * height)
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

    const compressed = new Uint8Array(deflateSync(raw, { level: 9 }))

    return concat(
        sig,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', new Uint8Array(0)),
    )
}

// Pre-generate cached images (purple #7C3AED = rgb(124, 58, 237))
export const OG_IMAGE = createSolidPNG(1200, 800, 124, 58, 237)
export const SPLASH_IMAGE = createSolidPNG(200, 200, 124, 58, 237)
export const ICON_IMAGE = createSolidPNG(1024, 1024, 124, 58, 237)

// Log sizes for debugging
console.log(`[png] OG_IMAGE: ${OG_IMAGE.length} bytes, SPLASH: ${SPLASH_IMAGE.length} bytes, ICON: ${ICON_IMAGE.length} bytes`)
