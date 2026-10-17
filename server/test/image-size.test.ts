/**
 * The pixel size that a manifest records is read from the image header. These
 * tests feed the reader synthetic headers; no server process runs.
 */

import { describe, expect, test } from "bun:test";
import { readImageSize } from "../src/image-size.js";
import { jpgWithSize, PNG_1X1_BASE64, pngWithSize } from "./helpers/plugin.js";

describe("readImageSize", () => {
  test("reads a real PNG", () => {
    expect(readImageSize(Buffer.from(PNG_1X1_BASE64, "base64"), "PNG")).toEqual({
      width: 1,
      height: 1,
    });
  });

  test("reads the size of a PNG header", () => {
    expect(readImageSize(pngWithSize(1920, 1080), "PNG")).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(pngWithSize(4_000_000, 3), "PNG")).toEqual({
      width: 4_000_000,
      height: 3,
    });
  });

  test("reads a PNG held in a view of a bigger buffer", () => {
    const inner = pngWithSize(33, 21);
    const outer = Buffer.concat([Buffer.alloc(5), inner]);
    expect(readImageSize(outer.subarray(5), "PNG")).toEqual({ width: 33, height: 21 });
  });

  test("refuses a PNG with a wrong signature, a wrong first chunk, or too few bytes", () => {
    const wrongSignature = pngWithSize(4, 4);
    wrongSignature[1] = 0x51;
    expect(readImageSize(wrongSignature, "PNG")).toBeNull();

    const wrongChunk = pngWithSize(4, 4);
    wrongChunk.write("IDAT", 12, "ascii");
    expect(readImageSize(wrongChunk, "PNG")).toBeNull();

    expect(readImageSize(pngWithSize(4, 4).subarray(0, 20), "PNG")).toBeNull();
    expect(readImageSize(Buffer.alloc(0), "PNG")).toBeNull();
  });

  test("refuses a PNG of size 0", () => {
    expect(readImageSize(pngWithSize(0, 5), "PNG")).toBeNull();
    expect(readImageSize(pngWithSize(5, 0), "PNG")).toBeNull();
  });

  test("reads the size of a JPG after its other segments", () => {
    expect(readImageSize(jpgWithSize(640, 480), "JPG")).toEqual({ width: 640, height: 480 });
    // 65535 is the largest edge a JPG holds.
    expect(readImageSize(jpgWithSize(65_535, 1), "JPG")).toEqual({ width: 65_535, height: 1 });
  });

  test("skips fill bytes, and a table segment whose marker looks like a frame marker", () => {
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
    const fill = Buffer.from([0xff, 0xff, 0xff]);
    const plain = jpgWithSize(30, 20);
    // SOI, then fill bytes and a DHT segment, then the rest.
    const bytes = Buffer.concat([plain.subarray(0, 2), fill, dht, plain.subarray(2)]);
    expect(readImageSize(bytes, "JPG")).toEqual({ width: 30, height: 20 });
  });

  test("reads a progressive JPG (SOF2)", () => {
    const bytes = jpgWithSize(9, 8);
    const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    bytes[sof + 1] = 0xc2;
    expect(readImageSize(bytes, "JPG")).toEqual({ width: 9, height: 8 });
  });

  test("refuses a JPG that has no SOF segment before the scan, or is cut short", () => {
    const scanFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(readImageSize(scanFirst, "JPG")).toBeNull();
    expect(readImageSize(jpgWithSize(8, 8).subarray(0, 24), "JPG")).toBeNull();
    expect(readImageSize(Buffer.from([0x00, 0x01, 0x02, 0x03]), "JPG")).toBeNull();
    expect(readImageSize(Buffer.alloc(0), "JPG")).toBeNull();
  });
});
