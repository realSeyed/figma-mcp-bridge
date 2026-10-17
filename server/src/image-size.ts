/**
 * The pixel size of a raster capture, read from its header. No decoder runs,
 * and the module imports nothing.
 *
 * A PNG holds its size in the IHDR chunk, which comes first. A JPG holds it in
 * the first SOF segment, after the other segments.
 */

export interface PixelSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A marker with no length: the start and the end of the image, and the restart markers. */
const isStandaloneMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0xd9;

/** A start-of-frame marker: C0 to CF, less the table markers C4, C8, and CC. */
const isFrameMarker = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * Reads the size of a PNG from its IHDR chunk.
 * @param bytes - The file.
 * @returns The size, or null if the signature or the chunk is not a PNG header.
 */
function readPngSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.byteLength < 24) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The first chunk is IHDR: a length of 13, the type, then width and height.
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Reads the size of a JPG from its first SOF segment.
 * @param bytes - The file.
 * @returns The size, or null if the file ends or reaches the scan before a SOF segment.
 */
function readJpgSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 2;
  while (position + 4 <= bytes.byteLength) {
    if (bytes[position] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may come before the marker byte.
    while (position < bytes.byteLength && bytes[position] === 0xff) position += 1;
    const marker = bytes[position];
    position += 1;
    if (isStandaloneMarker(marker)) continue;
    // Past the marker byte: the segment length (it counts its own 2 bytes).
    if (position + 2 > bytes.byteLength) return null;
    const length = view.getUint16(position);
    if (isFrameMarker(marker)) {
      // The length, the precision (1 byte), then the height and the width.
      if (length < 7 || position + 7 > bytes.byteLength) return null;
      return { width: view.getUint16(position + 5), height: view.getUint16(position + 3) };
    }
    // The scan starts after SOS; no SOF follows it.
    if (marker === 0xda) return null;
    position += length;
  }
  return null;
}

/**
 * Reads the pixel size of a PNG or a JPG.
 * @param bytes - The file contents.
 * @param format - `PNG` or `JPG`.
 * @returns The size, or null if the header cannot be read or the size is 0.
 */
export function readImageSize(bytes: Uint8Array, format: "PNG" | "JPG"): PixelSize | null {
  const size = format === "PNG" ? readPngSize(bytes) : readJpgSize(bytes);
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}
