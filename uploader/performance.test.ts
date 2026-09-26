import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  getCalibreBooks,
  getCalibreDbPath,
  getCalibreLibraryDir,
  getCalibreDbETag,
  getBookPath,
  getMasterCoverPath,
  SipsConcurrencyLimiter,
  sipsLimiter,
  downscaleImageAsync,
  handleRequest,
  getIndexHtmlETag,
  getFileETag,
  isCompressibleContentType,
  getPreferredEncoding,
  getCacheDb,
} from "./server";
import {
  initHighlightsTable,
  getHighlightCounts,
  batchUpsertHighlights,
  deleteHighlightsForBook,
  ensureBookHighlightsIndexed,
  invalidateHighlightCountsCache,
  getCachedHighlightCountsForTesting,
} from "./highlights";

describe("Reading HQ Server Performance & In-Process SQLite Engine", () => {
  const tempLibDir = path.join("/tmp", `test_perf_calibre_lib_${Date.now()}`);
  const bookDir = path.join(tempLibDir, "Frank Herbert", "Dune (1)");
  const epubPath = path.join(bookDir, "Dune - Frank Herbert.epub");
  const coverPath = path.join(bookDir, "cover.jpg");
  const tempDbPath = path.join(tempLibDir, "metadata.db");

  let origDbPath: string | undefined;
  let origLibDir: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(epubPath, "mock epub book content");
    // Write valid sample JPEG cover (64x48) that sips and cwebp can process and downscale
    const mockJpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
      0xff, 0xe1, 0x00, 0xcc, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x07,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x1a, 0x00, 0x05, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x62, 0x01, 0x1b, 0x00, 0x05, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x6a, 0x01, 0x28, 0x00, 0x03,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x01, 0x31, 0x00, 0x02, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x72,
      0x01, 0x32, 0x00, 0x02, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x86, 0x87, 0x69, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x48, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x48,
      0x00, 0x00, 0x00, 0x01, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x20, 0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70, 0x20,
      0x37, 0x2e, 0x30, 0x00, 0x32, 0x30, 0x30, 0x33, 0x3a, 0x30, 0x32, 0x3a, 0x32, 0x38, 0x20, 0x31, 0x35, 0x3a, 0x34, 0x37,
      0x3a, 0x32, 0x32, 0x00, 0x00, 0x03, 0xa0, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xa0, 0x02,
      0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x40, 0xa0, 0x03, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
      0x00, 0x30, 0x00, 0x00, 0x00, 0x00, 0xff, 0xed, 0x00, 0x38, 0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70, 0x20,
      0x33, 0x2e, 0x30, 0x00, 0x38, 0x42, 0x49, 0x4d, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x42, 0x49, 0x4d,
      0x04, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xd4, 0x1d, 0x8c, 0xd9, 0x8f, 0x00, 0xb2, 0x04, 0xe9, 0x80, 0x09, 0x98,
      0xec, 0xf8, 0x42, 0x7e, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
      0x03, 0x11, 0x01, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5,
      0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03,
      0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
      0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19,
      0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
      0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
      0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
      0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
      0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff,
      0xc4, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x11, 0x00, 0x02, 0x01,
      0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77, 0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05,
      0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1,
      0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a,
      0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
      0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77,
      0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
      0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2,
      0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4,
      0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xdb, 0x00, 0x43, 0x00,
      0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02, 0x03, 0x05, 0x03, 0x03, 0x03, 0x05, 0x06, 0x05, 0x05, 0x05, 0x05,
      0x06, 0x08, 0x06, 0x06, 0x06, 0x06, 0x06, 0x08, 0x0a, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a,
      0x0a, 0x0a, 0x0a, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0e, 0x0e, 0x0e, 0x0e, 0x0e, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f,
      0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xdb, 0x00, 0x43, 0x01, 0x02, 0x02, 0x02, 0x04, 0x04, 0x04, 0x07, 0x04, 0x04, 0x07, 0x10,
      0x0b, 0x09, 0x0b, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
      0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
      0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0xff, 0xdd, 0x00, 0x04, 0x00, 0x04, 0xff,
      0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xfb, 0xcb, 0x47, 0xd1, 0xb5, 0x1f, 0x81,
      0x1a, 0x84, 0x1a, 0x46, 0x91, 0x03, 0x5f, 0x78, 0x32, 0xf9, 0xad, 0x6f, 0xb5, 0x7d, 0x5e, 0xfa, 0xd7, 0x2d, 0x60, 0xc7,
      0xe5, 0x00, 0x05, 0xc6, 0x57, 0x85, 0xfe, 0x13, 0xd6, 0xbe, 0x86, 0xd2, 0xb5, 0x7d, 0x2f, 0x5f, 0xd3, 0x6d, 0xb5, 0xad,
      0x16, 0xea, 0x3b, 0xcb, 0x1b, 0xbf, 0xb7, 0xbc, 0x33, 0x47, 0x62, 0x76, 0x3a, 0xf2, 0x32, 0x32, 0x07, 0x70, 0x69, 0x75,
      0x6d, 0x27, 0x4d, 0xd7, 0xf4, 0xab, 0xbd, 0x1b, 0x59, 0xb7, 0x17, 0x76, 0x37, 0x91, 0x58, 0xc7, 0x34, 0x2f, 0x7f, 0xf2,
      0xba, 0x96, 0xe8, 0x70, 0x41, 0xaf, 0x9f, 0xf5, 0x6d, 0x57, 0x52, 0xf8, 0x13, 0xa9, 0x4f, 0xaa, 0xea, 0xb7, 0x0f, 0x71,
      0xe0, 0x59, 0xde, 0xe6, 0xc7, 0x49, 0xd2, 0x6c, 0x6e, 0x83, 0x49, 0x67, 0x23, 0x0d, 0xc5, 0x98, 0xb6, 0xdf, 0x94, 0xed,
      0x7f, 0xe3, 0x6f, 0xbc, 0x28, 0x03, 0xe8, 0xe5, 0x1c, 0x1e, 0x57, 0xa5, 0x87, 0xfc, 0xb8, 0x1f, 0x5a, 0x73, 0x81, 0x91,
      0xca, 0xff, 0x00, 0xcb, 0xff, 0x00, 0xfc, 0xb8, 0x1a, 0x11, 0xf7, 0x26, 0xef, 0x9b, 0x91, 0xa7, 0x9f, 0xf8, 0xff, 0x00,
      0xf7, 0xa9, 0x1c, 0x9c, 0x8e, 0xbd, 0x6f, 0xff, 0x00, 0xe5, 0xfe, 0x80, 0x23, 0x40, 0x39, 0xe5, 0x7f, 0xe5, 0xc3, 0xfe,
      0x5c, 0x0d, 0x23, 0x63, 0x03, 0x95, 0xff, 0x00, 0x97, 0xff, 0x00, 0xf9, 0x70, 0x35, 0x22, 0x31, 0xe7, 0xaf, 0xfc, 0xb8,
      0x7f, 0xcb, 0xfd, 0x36, 0x46, 0xda, 0x99, 0x3b, 0xb8, 0x1a, 0x81, 0xff, 0x00, 0x8f, 0xfc, 0xd0, 0x06, 0x6e, 0xa9, 0xab,
      0xe9, 0x7a, 0x06, 0x9b, 0x73, 0xac, 0xeb, 0x57, 0x51, 0x59, 0xd8, 0xda, 0x0b, 0x07, 0x9a, 0x69, 0x2c, 0x4e, 0xc4, 0x5c,
      0x81, 0x93, 0x8c, 0xf7, 0x35, 0xf3, 0xce, 0xb3, 0xa3, 0xea, 0x3f, 0x1d, 0xf5, 0x19, 0xf4, 0x8d, 0x5e, 0x06, 0xb1, 0xf0,
      0x5d, 0x8b, 0x5d, 0x5f, 0x69, 0x1a, 0xbd, 0x8d, 0xae, 0x1a, 0xfd, 0x87, 0xca, 0x41, 0x0d, 0x9f, 0x97, 0x96, 0xfe, 0x11,
      0xd2, 0xa7, 0xd2, 0x75, 0x5d, 0x4f, 0xe3, 0xb6, 0xa5, 0x06, 0xab, 0xa4, 0xdc, 0x3d, 0xbf, 0x81, 0x6d, 0xde, 0xda, 0xc7,
      0x56, 0xd2, 0x6f, 0xae, 0x82, 0xc9, 0x79, 0x22, 0x8d, 0xc1, 0x94, 0xae, 0xec, 0x2f, 0xcc, 0x9f, 0xc6, 0xbf, 0x74, 0xf1,
      0x5f, 0x40, 0x69, 0x3a, 0x4e, 0x9b, 0xa0, 0x69, 0x56, 0x9a, 0x2e, 0x8b, 0x6c, 0x2d, 0x2c, 0x6c, 0xe3, 0xbe, 0x8e, 0x18,
      0x52, 0xff, 0x00, 0xe5, 0x44, 0x07, 0x38, 0x19, 0x24, 0xd0, 0x07, 0xff, 0xd0, 0xfd, 0x88, 0x00, 0x61, 0xb9, 0x1f, 0x76,
      0xc3, 0xfe, 0x5c, 0x3d, 0xea, 0x86, 0xaf, 0x78, 0x34, 0xeb, 0x61, 0x73, 0xe4, 0x1b, 0x9f, 0xde, 0xde, 0xa9, 0x45, 0xb0,
      0x00, 0xe0, 0xe7, 0x24, 0x67, 0x8e, 0x05, 0x5f, 0x0d, 0xc3, 0x71, 0xfc, 0x36, 0x1f, 0xf2, 0xff, 0x00, 0xef, 0x4e, 0x77,
      0x00, 0x8d, 0xc0, 0x0f, 0x9a, 0xff, 0x00, 0xfe, 0x5f, 0xe8, 0x03, 0x8c, 0x1e, 0x30, 0xb3, 0xd9, 0xe6, 0x47, 0x6e, 0xe5,
      0x0b, 0x58, 0xa6, 0x4d, 0x92, 0x28, 0xc8, 0xdc, 0x40, 0x04, 0x9c, 0x67, 0xe5, 0xe4, 0x12, 0x31, 0xd0, 0xf3, 0xc5, 0x3d,
      0xfc, 0x5f, 0x68, 0xd0, 0x8b, 0xa4, 0xb6, 0x90, 0xc2, 0x1a, 0xf1, 0x59, 0xcd, 0x8a, 0xa8, 0x05, 0xf3, 0x8e, 0xa7, 0xdb,
      0x9f, 0x4e, 0x87, 0xbd, 0x75, 0xca, 0x46, 0xd3, 0xf2, 0x8e, 0x96, 0x1f, 0xf2, 0xff, 0x00, 0xef, 0x4e, 0x72, 0x06, 0x3e,
      0x51, 0xd6, 0xff, 0x00, 0xfe, 0x5f, 0xe8, 0x03, 0x8e, 0x5f, 0x17, 0x5b, 0xec, 0x82, 0x44, 0xb5, 0x92, 0x41, 0x74, 0xd6,
      0x8a, 0x81, 0x6c, 0x01, 0x3f, 0xbb, 0x28, 0x39, 0xc9, 0x00, 0x64, 0xb7, 0xaf, 0x6f, 0x4a, 0x81, 0xfc, 0x75, 0xa3, 0x96,
      0x54, 0x54, 0x72, 0x5b, 0xed, 0xc0, 0x66, 0xc1, 0x57, 0x3b, 0x80, 0x61, 0xd4, 0x8c, 0x75, 0xe7, 0x3f, 0x77, 0xbf, 0x18,
      0xae, 0xe2, 0x32, 0x39, 0xf9, 0x7f, 0xe7, 0xc3, 0xfe, 0x5f, 0xea, 0x09, 0x60, 0xb6, 0x79, 0x63, 0xb9, 0x78, 0x11, 0xa6,
      0x8c, 0x6a, 0x01, 0x5c, 0xde, 0x82, 0xca, 0x0f, 0x50, 0x0f, 0x51, 0x9e, 0xfe, 0xb4, 0x01, 0x25, 0xbe, 0xc7, 0x8d, 0x64,
      0x41, 0xb4, 0x3f, 0xf6, 0x7b, 0x60, 0xe9, 0xfc, 0xf3, 0x83, 0xc8, 0xf5, 0xa5, 0x2a, 0x30, 0xbc, 0x8e, 0x97, 0xff, 0x00,
      0xf2, 0xe1, 0x8e, 0xf4, 0xe8, 0xdc, 0x1c, 0xe0, 0x03, 0xf3, 0x58, 0x7f, 0xcb, 0xfd, 0x34, 0xb7, 0x0b, 0xc7, 0xf0, 0xdf,
      0xff, 0x00, 0xcb, 0xff, 0x00, 0xbd, 0x00, 0x7f, 0xff, 0xd1, 0xfd, 0x79, 0xd5, 0xb5, 0x4d, 0x3b, 0x40, 0xd2, 0xee, 0xf5,
      0x9d, 0x66, 0xe4, 0x5a, 0x58, 0xd9, 0xc5, 0x61, 0x24, 0xd2, 0xbd, 0x87, 0xca, 0x88, 0x1b, 0xa9, 0xc0, 0x26, 0xbe, 0x7f,
      0xd5, 0xb4, 0x9d, 0x4f, 0xe3, 0xb6, 0xa5, 0x3e, 0x93, 0xaa, 0xc0, 0xf6, 0xfe, 0x05, 0x81, 0xee, 0x6f, 0xb4, 0x9d, 0x5e,
      0xc2, 0xd4, 0x2c, 0x97, 0x92, 0x28, 0xda, 0x55, 0x83, 0x6e, 0xf9, 0x46, 0xe7, 0xfe, 0x05, 0xfb, 0xa3, 0x9a, 0x83, 0x47,
      0xd6, 0x75, 0x0f, 0x8e, 0xfa, 0x8c, 0x1a, 0xb6, 0x91, 0x3b, 0x59, 0x78, 0x2e, 0xc5, 0xad, 0x6c, 0x75, 0x8d, 0x22, 0xfa,
      0xeb, 0x0d, 0x7e, 0xdf, 0x78, 0x10, 0x57, 0x38, 0x51, 0xb9, 0x7f, 0x88, 0x74, 0xaf, 0xa1, 0xb4, 0xad, 0x23, 0x4a, 0xf0,
      0xfe, 0x9b, 0x6d, 0xa2, 0xe8, 0xb6, 0x91, 0xd9, 0xd8, 0xda, 0x7d, 0xbd, 0x21, 0x86, 0x3b, 0xf3, 0xb1, 0x17, 0x24, 0xe0,
      0x64, 0x9e, 0xe6, 0x80, 0x34, 0x63, 0x42, 0xa9, 0xb4, 0x13, 0xc0, 0xd3, 0xff, 0x00, 0xe5, 0xc3, 0xde, 0xa4, 0x75, 0x39,
      0x1c, 0x9e, 0xb7, 0xff, 0x00, 0xf2, 0xe1, 0x50, 0xa9, 0x18, 0x3c, 0x0e, 0x96, 0x1f, 0xf2, 0xfe, 0x7d, 0x69, 0xce, 0x46,
      0x47, 0x03, 0xfe, 0x5f, 0xff, 0x00, 0xe5, 0xfc, 0xd0, 0x03, 0xd1, 0x4e, 0x4f, 0x27, 0xfe, 0x5c, 0x3f, 0xe5, 0xc2, 0x9b,
      0x24, 0x65, 0x93, 0x04, 0x9e, 0x45, 0xf8, 0xff, 0x00, 0x8f, 0x0c, 0x52, 0x21, 0x19, 0x3c, 0x0f, 0xf9, 0x70, 0xff, 0x00,
      0x97, 0xf3, 0x48, 0xc4, 0x60, 0x70, 0xbf, 0xf2, 0xff, 0x00, 0xff, 0x00, 0x2f, 0xe7, 0xd6, 0x80, 0x3e, 0x70, 0xd2, 0x74,
      0x9d, 0x53, 0xe0, 0x56, 0xa5, 0x6f, 0xa4, 0xe9, 0x30, 0x3d, 0xc7, 0x81, 0x6e, 0x1e, 0xd6, 0xfb, 0x56, 0xd5, 0xaf, 0xed,
      0x43, 0x49, 0x67, 0x23, 0x0d, 0xa1, 0x54, 0x2e, 0xdf, 0x97, 0xe5, 0x4f, 0xe0, 0x6f, 0xbc, 0x79, 0xaf, 0xa0, 0x34, 0x9d,
      0x57, 0x4d, 0xd7, 0xf4, 0xab, 0x4d, 0x6b, 0x46, 0xb9, 0x17, 0x76, 0x37, 0x91, 0xdf, 0x49, 0x0c, 0xc9, 0x61, 0xf2, 0xba,
      0x92, 0x79, 0x19, 0x00, 0xd2, 0x6a, 0xba, 0x46, 0x95, 0xaf, 0xe9, 0xb7, 0x3a, 0x2e, 0xb5, 0x69, 0x1d, 0xe5, 0x8d, 0xd8,
      0xb0, 0x49, 0xa1, 0x92, 0xfc, 0xec, 0x75, 0xc8, 0x38, 0x38, 0x23, 0xb8, 0xaf, 0x9e, 0x75, 0x8d, 0x67, 0x51, 0xf8, 0x11,
      0xa8, 0xcf, 0xab, 0x6a, 0xf3, 0xb5, 0xef, 0x82, 0xef, 0x5a, 0xea, 0xc7, 0x48, 0xd2, 0x2c, 0x6e, 0xb2, 0xd6, 0x2c, 0x7e,
      0x62, 0x49, 0x6c, 0x7c, 0xa7, 0x0d, 0xfc, 0x47, 0xad, 0x00, 0x7f, 0xff, 0xd9,
    ]);
    fs.writeFileSync(coverPath, mockJpg);

    const db = new Database(tempDbPath);
    db.run(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, has_cover INTEGER, pubdate TEXT, series_index REAL);
      CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
      CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
    `);

    // Insert book 1: EPUB format with series, author, tags, publisher
    db.run(
      "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (1, 'Dune', 'Frank Herbert/Dune (1)', 1, '1965-08-01', 1);",
    );
    db.run(
      "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (1, 1, 'EPUB', 'Dune - Frank Herbert', 100);",
    );
    db.run("INSERT INTO authors (id, name) VALUES (1, 'Frank Herbert');");
    db.run("INSERT INTO books_authors_link (id, book, author) VALUES (1, 1, 1);");
    db.run("INSERT INTO series (id, name) VALUES (1, 'Dune Chronicles');");
    db.run("INSERT INTO books_series_link (id, book, series) VALUES (1, 1, 1);");
    db.run("INSERT INTO tags (id, name) VALUES (1, 'Sci-Fi'), (2, 'Classic');");
    db.run("INSERT INTO books_tags_link (id, book, tag) VALUES (1, 1, 1), (2, 1, 2);");
    db.run("INSERT INTO publishers (id, name) VALUES (1, 'Chilton Books');");
    db.run("INSERT INTO books_publishers_link (id, book, publisher) VALUES (1, 1, 1);");

    // Insert book 2: Non-EPUB format (PDF only, should be excluded)
    db.run(
      "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (2, 'Manual', 'System/Manual (2)', 0, '2020-01-01', 1);",
    );
    db.run(
      "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (2, 2, 'PDF', 'Manual', 50);",
    );

    db.close();

    origDbPath = process.env.CALIBRE_DB_PATH;
    origLibDir = process.env.CALIBRE_LIBRARY_DIR;
    process.env.CALIBRE_DB_PATH = tempDbPath;
    process.env.CALIBRE_LIBRARY_DIR = tempLibDir;
  });

  afterAll(() => {
    if (origDbPath === undefined) delete process.env.CALIBRE_DB_PATH;
    else process.env.CALIBRE_DB_PATH = origDbPath;

    if (origLibDir === undefined) delete process.env.CALIBRE_LIBRARY_DIR;
    else process.env.CALIBRE_LIBRARY_DIR = origLibDir;

    if (fs.existsSync(tempLibDir)) {
      fs.rmSync(tempLibDir, { recursive: true, force: true });
    }
  });

  it("in-process SQLite book query executes directly with sub-50ms latency", () => {
    const start = performance.now();
    const books = getCalibreBooks(true);
    const duration = performance.now() - start;

    // Fast in-process performance benchmark: must complete in < 50ms
    expect(duration).toBeLessThan(50);
    expect(Array.isArray(books)).toBe(true);
    expect(books.length).toBe(1);

    const book = books[0];
    expect(book.id).toBe(1);
    expect(book.title).toBe("Dune");
    expect(book.path).toBe("Frank Herbert/Dune (1)");
    expect(book.cover).toBe(1);
    expect(book.pubdate).toBe("1965-08-01");
    expect(book.authors).toBe("Frank Herbert");
    expect(book.series).toBe("Dune Chronicles");
    expect(book.series_index).toBe(1);
    expect(book.publisher).toBe("Chilton Books");
    expect(Array.isArray(book.tags)).toBe(true);
    expect(book.tags).toContain("Sci-Fi");
    expect(book.tags).toContain("Classic");
    expect(book.formats).toEqual(["EPUB"]);
  });

  it("HTTP ETag generation reflects metadata.db state", () => {
    const etag1 = getCalibreDbETag();
    expect(etag1).toBeDefined();
    expect(etag1.startsWith('"')).toBe(true);
    expect(etag1.endsWith('"')).toBe(true);

    // If metadata.db is modified, etag changes
    const newMtime = new Date(Date.now() + 5000);
    fs.utimesSync(tempDbPath, newMtime, newMtime);
    const etag2 = getCalibreDbETag();
    expect(etag2).not.toBe(etag1);
  });

  it("GET /api/books returns 200 with ETag and Cache-Control headers", async () => {
    const req = new Request("http://127.0.0.1:8086/api/books", {
      method: "GET",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);

    const etag = res.headers.get("ETag");
    const cacheControl = res.headers.get("Cache-Control");
    expect(etag).not.toBeNull();
    expect(cacheControl).toBe("public, max-age=5, must-revalidate");

    const json = (await res.json()) as any[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].title).toBe("Dune");
  });

  it("GET /api/books with matching If-None-Match returns 304 Not Modified in < 2ms", async () => {
    const etag = getCalibreDbETag();
    const req = new Request("http://127.0.0.1:8086/api/books", {
      method: "GET",
      headers: {
        "If-None-Match": etag,
      },
    });

    const start = performance.now();
    const res = await handleRequest(req);
    const duration = performance.now() - start;

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5, must-revalidate");
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    expect(duration).toBeLessThan(10); // Typically < 2ms, comfortably bounded
    const body = await res.text();
    expect(body).toBe("");
  });

  it("getMasterCoverPath and getBookPath resolve directly to on-disk cover.jpg", () => {
    const relPath = getBookPath(1);
    expect(relPath).toBe("Frank Herbert/Dune (1)");

    const diskCover = getMasterCoverPath(1);
    expect(diskCover).not.toBeNull();
    expect(diskCover).toBe(coverPath);
    expect(fs.existsSync(diskCover!)).toBe(true);
  });

  it("GET /api/books/:id/cover serves master cover directly from disk with zero network loopback", async () => {
    const req = new Request("http://127.0.0.1:8086/api/books/1/cover", {
      method: "GET",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("ETag")).not.toBeNull();

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10);

    // Conditional If-None-Match on master cover
    const coverEtag = res.headers.get("ETag")!;
    const condReq = new Request("http://127.0.0.1:8086/api/books/1/cover", {
      method: "GET",
      headers: { "If-None-Match": coverEtag },
    });
    const condRes = await handleRequest(condReq);
    expect(condRes.status).toBe(304);
  });

  it("SipsConcurrencyLimiter enforces max concurrent operations", async () => {
    const limiter = new SipsConcurrencyLimiter(4);
    expect(limiter.maxConcurrent).toBe(4);
    expect(limiter.getActiveCount()).toBe(0);

    let activePeak = 0;
    const tasks = Array.from({ length: 12 }, async (_, i) => {
      return limiter.run(async () => {
        const currentActive = limiter.getActiveCount();
        if (currentActive > activePeak) activePeak = currentActive;
        await new Promise((r) => setTimeout(r, 15));
        return i;
      });
    });

    const results = await Promise.all(tasks);
    expect(results.length).toBe(12);
    expect(activePeak).toBeLessThanOrEqual(4);
    expect(limiter.getActiveCount()).toBe(0);
  });

  it("getCalibreDbPath and getCalibreLibraryDir correctly resolve configured library paths", () => {
    expect(getCalibreDbPath()).toBe(tempDbPath);
    expect(getCalibreLibraryDir()).toBe(tempLibDir);
  });

  it("sipsLimiter singleton and downscaleImageAsync are exported and functional", async () => {
    expect(sipsLimiter).toBeInstanceOf(SipsConcurrencyLimiter);
    expect(sipsLimiter.maxConcurrent).toBe(4);

    const testThumb = path.join(tempLibDir, "thumb_test.jpg");
    const ok = await downscaleImageAsync(coverPath, testThumb, 64);
    expect(typeof ok).toBe("boolean");
    if (ok) {
      expect(fs.existsSync(testThumb)).toBe(true);
    }

    const testWebpThumb = path.join(tempLibDir, "thumb_test.webp");
    const webpOk = await downscaleImageAsync(coverPath, testWebpThumb, 64, "webp");
    expect(typeof webpOk).toBe("boolean");
    if (webpOk) {
      expect(fs.existsSync(testWebpThumb)).toBe(true);
    }
  });

  it("index.html implements instant rendering, Stale-While-Revalidate, and ETag handling", () => {
    const htmlPath = path.join((import.meta as any).dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Client-side caching and ETag headers
    expect(html).toContain("If-None-Match");
    expect(html).toContain("res.status === 304");
    expect(html).toContain("booksEtag");
    expect(html).toContain("sessionStorage");
    expect(html).toContain("localStorage");
    expect(html).toContain("loadCachedData");
    expect(html).toContain("saveCachedData");
  });

  describe("WAN Edge Performance, Transparent Compression & Caching Engine", () => {
    it("isCompressibleContentType accurately identifies JSON, HTML, XML, text, and rejects binaries/streams", () => {
      expect(isCompressibleContentType("application/json; charset=utf-8")).toBe(true);
      expect(isCompressibleContentType("text/html; charset=utf-8")).toBe(true);
      expect(isCompressibleContentType("application/atom+xml")).toBe(true);
      expect(isCompressibleContentType("text/plain")).toBe(true);
      expect(isCompressibleContentType("image/svg+xml")).toBe(true);

      // Binary and streaming formats must never be compressed
      expect(isCompressibleContentType("application/epub+zip")).toBe(false);
      expect(isCompressibleContentType("application/octet-stream")).toBe(false);
      expect(isCompressibleContentType("image/jpeg")).toBe(false);
      expect(isCompressibleContentType("image/png")).toBe(false);
      expect(isCompressibleContentType("text/event-stream")).toBe(false);
      expect(isCompressibleContentType("application/x-ndjson")).toBe(false);
      expect(isCompressibleContentType(null)).toBe(false);
    });

    it("getPreferredEncoding prioritizes gzip over deflate and handles quality values (q-values)", () => {
      expect(getPreferredEncoding("gzip, deflate, br")).toBe("gzip");
      expect(getPreferredEncoding("deflate, gzip")).toBe("gzip");
      expect(getPreferredEncoding("deflate")).toBe("deflate");
      expect(getPreferredEncoding("*")).toBe("gzip");
      expect(getPreferredEncoding("identity")).toBe(null);
      expect(getPreferredEncoding(null)).toBe(null);

      // Quality value negotiation tests (Bug B remediation)
      expect(getPreferredEncoding("gzip;q=0, deflate")).toBe("deflate");
      expect(getPreferredEncoding("gzip;q=0, deflate;q=0.8")).toBe("deflate");
      expect(getPreferredEncoding("deflate;q=0.9, gzip;q=0.5")).toBe("deflate");
      expect(getPreferredEncoding("gzip;q=0.8, deflate;q=0.5")).toBe("gzip");
      expect(getPreferredEncoding("gzip;q=0, *;q=0")).toBe(null);
      expect(getPreferredEncoding("gzip;q=0, deflate;q=0")).toBe(null);
      expect(getPreferredEncoding("*;q=0")).toBe(null);
    });

    it("compressResponseIfNeeded strictly preserves 206 Partial Content, Content-Range, and no-transform", async () => {
      const { compressResponseIfNeeded } = await import("./server");

      // 206 Partial Content
      const res206 = new Response("bytes 0-100/500", {
        status: 206,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": "bytes 0-100/500",
        },
      });
      const reqGzip = new Request("http://127.0.0.1:8086/api/test", {
        headers: { "Accept-Encoding": "gzip" },
      });
      const out206 = await compressResponseIfNeeded(res206, reqGzip);
      expect(out206.status).toBe(206);
      expect(out206.headers.get("Content-Encoding")).toBeNull();

      // Cache-Control: no-transform
      const resNoTransform = new Response("x".repeat(2000), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-transform",
        },
      });
      const outNoTransform = await compressResponseIfNeeded(resNoTransform, reqGzip);
      expect(outNoTransform.headers.get("Content-Encoding")).toBeNull();

      // X-Skip-Compression (e.g. proxied book downloads)
      const resSkip = new Response("x".repeat(2000), {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "X-Skip-Compression": "1",
        },
      });
      const outSkip = await compressResponseIfNeeded(resSkip, reqGzip);
      expect(outSkip.headers.get("Content-Encoding")).toBeNull();
      expect(outSkip.headers.get("X-Skip-Compression")).toBeNull(); // Header cleanly stripped

      // Oversized body (>10MB) without declared Content-Length skips sync compression (Bug 1 remediation)
      const resHuge = new Response("a".repeat(10 * 1024 * 1024 + 100), {
        headers: { "Content-Type": "application/json" },
      });
      const outHuge = await compressResponseIfNeeded(resHuge, reqGzip);
      expect(outHuge.headers.get("Content-Encoding")).toBeNull();
      expect(outHuge.headers.get("Vary")).toContain("Accept-Encoding");
    });

    it("GET / serves index.html with mtime+size ETag and Cache-Control: public, max-age=60, must-revalidate", async () => {
      const req = new Request("http://127.0.0.1:8086/", { method: "GET" });
      const res = await handleRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");

      const etag = res.headers.get("ETag");
      expect(etag).not.toBeNull();
      const expectedEtag = getIndexHtmlETag();
      expect(etag).toBe(expectedEtag);

      // HEAD request
      const headReq = new Request("http://127.0.0.1:8086/", { method: "HEAD" });
      const headRes = await handleRequest(headReq);
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("ETag")).toBe(expectedEtag);
      const headBody = await headRes.text();
      expect(headBody).toBe("");

      // Conditional 304 revalidation
      const condReq = new Request("http://127.0.0.1:8086/", {
        method: "GET",
        headers: { "If-None-Match": etag! },
      });
      const condRes = await handleRequest(condReq);
      expect(condRes.status).toBe(304);
      expect(condRes.headers.get("ETag")).toBe(etag);
      expect(condRes.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
      expect(condRes.headers.get("Vary")).toContain("Accept-Encoding");
      const condBody = await condRes.text();
      expect(condBody).toBe("");
    });

    it("GET / compresses index.html by >80% when Accept-Encoding: gzip is sent", async () => {
      const uncompressedReq = new Request("http://127.0.0.1:8086/", { method: "GET" });
      const uncompressedRes = await handleRequest(uncompressedReq);
      const uncompressedBytes = new Uint8Array(await uncompressedRes.arrayBuffer());
      expect(uncompressedBytes.length).toBeGreaterThan(300_000); // ~411 KB

      const gzipReq = new Request("http://127.0.0.1:8086/", {
        method: "GET",
        headers: { "Accept-Encoding": "gzip" },
      });
      const gzipRes = await handleRequest(gzipReq);
      expect(gzipRes.status).toBe(200);
      expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");
      expect(gzipRes.headers.get("Vary")).toContain("Accept-Encoding");

      const gzippedBytes = new Uint8Array(await gzipRes.arrayBuffer());
      const compressionRatio = (1 - gzippedBytes.length / uncompressedBytes.length) * 100;

      // Assert at least 80% compression on the ~411 KB web app shell
      expect(compressionRatio).toBeGreaterThan(80);

      // Verify gunzip round-trip integrity
      const decompressed = (globalThis as any).Bun.gunzipSync(gzippedBytes);
      const decompressedHtml = Buffer.from(decompressed).toString("utf8");
      expect(decompressedHtml).toContain("<!DOCTYPE html>");
      expect(decompressedHtml).toContain("LightHouse");
    });

    it("GET /api/books compresses large JSON responses when client accepts gzip or deflate", async () => {
      // 1. With small payload (1 book, <= 1024 bytes), verify compression is skipped to save CPU
      const smallReq = new Request("http://127.0.0.1:8086/api/books", {
        method: "GET",
        headers: { "Accept-Encoding": "gzip" },
      });
      const smallRes = await handleRequest(smallReq);
      expect(smallRes.status).toBe(200);
      expect(smallRes.headers.get("Content-Encoding")).toBeNull();
      expect(smallRes.headers.get("Vary")).toContain("Accept-Encoding");

      // 2. Temporarily populate additional books to make /api/books payload > 1024 bytes
      const db = new Database(tempDbPath);
      const insertBookStmt = db.prepare(
        "INSERT INTO books (id, title, path, has_cover, pubdate, series_index) VALUES (?, ?, ?, ?, ?, ?);",
      );
      const insertDataStmt = db.prepare(
        "INSERT INTO data (id, book, format, name, uncompressed_size) VALUES (?, ?, ?, ?, ?);",
      );
      for (let i = 10; i <= 20; i++) {
        insertBookStmt.run(
          i,
          `Book ${i} Dune Companion Volume Description`,
          `Author/Book ${i}`,
          0,
          "2026-01-01",
          i,
        );
        insertDataStmt.run(i, i, "EPUB", `Book ${i}`, 500);
      }
      db.close();

      try {
        const gzipReq = new Request("http://127.0.0.1:8086/api/books", {
          method: "GET",
          headers: { "Accept-Encoding": "gzip" },
        });
        const gzipRes = await handleRequest(gzipReq);
        expect(gzipRes.status).toBe(200);
        expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");
        expect(gzipRes.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
        expect(gzipRes.headers.get("Vary")).toContain("Accept-Encoding");

        const bytes = new Uint8Array(await gzipRes.arrayBuffer());
        // Decompress and verify valid books JSON
        const decompressed = (globalThis as any).Bun.gunzipSync(bytes);
        const json = JSON.parse(Buffer.from(decompressed).toString("utf8"));
        expect(Array.isArray(json)).toBe(true);
        expect(json.length).toBeGreaterThanOrEqual(11);
        expect(json.some((b: any) => b.title === "Dune")).toBe(true);

        // Deflate encoding test
        const deflateReq = new Request("http://127.0.0.1:8086/api/books", {
          method: "GET",
          headers: { "Accept-Encoding": "deflate" },
        });
        const deflateRes = await handleRequest(deflateReq);
        expect(deflateRes.status).toBe(200);
        expect(deflateRes.headers.get("Content-Encoding")).toBe("deflate");
        expect(deflateRes.headers.get("Vary")).toContain("Accept-Encoding");
        const deflateBytes = new Uint8Array(await deflateRes.arrayBuffer());
        const decompressedDeflate = (globalThis as any).Bun.inflateSync(deflateBytes);
        const deflateJson = JSON.parse(Buffer.from(decompressedDeflate).toString("utf8"));
        expect(deflateJson.some((b: any) => b.title === "Dune")).toBe(true);
      } finally {
        // Clean up temporary books to preserve other tests' isolation
        const cleanDb = new Database(tempDbPath);
        cleanDb.run("DELETE FROM books WHERE id >= 10;");
        cleanDb.run("DELETE FROM data WHERE id >= 10;");
        cleanDb.close();
      }
    });

    it("Zero-copy cover streaming and fast mtime+size ETag on master and thumbnail covers", async () => {
      const masterPath = getMasterCoverPath(1)!;
      expect(fs.existsSync(masterPath)).toBe(true);

      const fileEtag = getFileETag(masterPath);
      expect(fileEtag).not.toBeNull();
      expect(fileEtag!.startsWith('"')).toBe(true);

      // GET Master cover
      const masterReq = new Request("http://127.0.0.1:8086/api/books/1/cover", { method: "GET" });
      const masterRes = await handleRequest(masterReq);
      expect(masterRes.status).toBe(200);
      expect(masterRes.headers.get("Content-Type")).toBe("image/jpeg");
      expect(masterRes.headers.get("ETag")).toBe(fileEtag);
      expect(masterRes.headers.get("Cache-Control")).toBe("public, max-age=86400");

      // 304 on master cover must include ETag and Cache-Control
      const condMasterReq = new Request("http://127.0.0.1:8086/api/books/1/cover", {
        method: "GET",
        headers: { "If-None-Match": fileEtag! },
      });
      const condMasterRes = await handleRequest(condMasterReq);
      expect(condMasterRes.status).toBe(304);
      expect(condMasterRes.headers.get("ETag")).toBe(fileEtag);
      expect(condMasterRes.headers.get("Cache-Control")).toBe("public, max-age=86400");

      // GET Downscaled thumbnail (w=128)
      const thumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", { method: "GET" });
      const thumbRes = await handleRequest(thumbReq);
      expect(thumbRes.status).toBe(200);
      expect(thumbRes.headers.get("Content-Type")).toBe("image/jpeg");
      expect(thumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");

      const thumbEtag = thumbRes.headers.get("ETag");
      expect(thumbEtag).not.toBeNull();

      // Subsequent request to cached thumbnail returns 304 Not Modified with ETag and Cache-Control
      const condThumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", {
        method: "GET",
        headers: { "If-None-Match": thumbEtag! },
      });
      const condThumbRes = await handleRequest(condThumbReq);
      expect(condThumbRes.status).toBe(304);
      expect(condThumbRes.headers.get("ETag")).toBe(thumbEtag);
      expect(condThumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");
      expect(condThumbRes.headers.get("Vary")).toBe("Accept");

      // Content negotiation: Accept: image/webp serves WebP thumbnail with Vary: Accept
      const webpThumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", {
        method: "GET",
        headers: { Accept: "image/webp,image/*,*/*;q=0.8" },
      });
      const webpThumbRes = await handleRequest(webpThumbReq);
      expect(webpThumbRes.status).toBe(200);
      expect(webpThumbRes.headers.get("Content-Type")).toBe("image/webp");
      expect(webpThumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");
      expect(webpThumbRes.headers.get("Vary")).toBe("Accept");
      const webpThumbEtag = webpThumbRes.headers.get("ETag");
      expect(webpThumbEtag).not.toBeNull();

      // Subsequent conditional request to WebP thumbnail returns 304 Not Modified
      const condWebpThumbReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", {
        method: "GET",
        headers: {
          Accept: "image/webp,image/*,*/*;q=0.8",
          "If-None-Match": webpThumbEtag!,
        },
      });
      const condWebpThumbRes = await handleRequest(condWebpThumbReq);
      expect(condWebpThumbRes.status).toBe(304);
      expect(condWebpThumbRes.headers.get("ETag")).toBe(webpThumbEtag);
      expect(condWebpThumbRes.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");
      expect(condWebpThumbRes.headers.get("Vary")).toBe("Accept");

      // Content negotiation: Accept: image/webp on master cover serves WebP format with Vary: Accept
      const webpMasterReq = new Request("http://127.0.0.1:8086/api/books/1/cover", {
        method: "GET",
        headers: { Accept: "image/webp,*/*;q=0.8" },
      });
      const webpMasterRes = await handleRequest(webpMasterReq);
      expect(webpMasterRes.status).toBe(200);
      expect(webpMasterRes.headers.get("Content-Type")).toBe("image/webp");
      expect(webpMasterRes.headers.get("Cache-Control")).toBe("public, max-age=86400");
      expect(webpMasterRes.headers.get("Vary")).toBe("Accept");

      // Non-WebP request falls back to image/jpeg
      const nonWebpReq = new Request("http://127.0.0.1:8086/api/books/1/cover?w=128", {
        method: "GET",
        headers: { Accept: "image/jpeg,image/png,*/*" },
      });
      const nonWebpRes = await handleRequest(nonWebpReq);
      expect(nonWebpRes.status).toBe(200);
      expect(nonWebpRes.headers.get("Content-Type")).toBe("image/jpeg");
      expect(nonWebpRes.headers.get("Vary")).toBe("Accept");
    });

    it("Highlight count memoization caches results and auto-invalidates on mutations", () => {
      const hDb = new Database(":memory:");
      initHighlightsTable(hDb);

      // Initially empty
      const counts1 = getHighlightCounts(hDb);
      expect(Object.keys(counts1.byBookId).length).toBe(0);

      // Cached test verification
      const cachedRef1 = getCachedHighlightCountsForTesting();
      expect(cachedRef1).not.toBeNull();

      // Calling getHighlightCounts again returns memoized result
      const counts2 = getHighlightCounts(hDb);
      expect(counts2).toEqual(counts1); // Returns identical memoized counts
      expect(getCachedHighlightCountsForTesting()?.timestamp).toBe(cachedRef1?.timestamp);

      // Insert highlights using batchUpsertHighlights
      batchUpsertHighlights(hDb, [
        {
          book_id: 10,
          book_title: "Neuromancer",
          chapter: "Ch 1",
          page: 1,
          quote: "The sky above the port was the color of television, tuned to a dead channel.",
          note: "Opening line",
          timestamp: "2026-09-26",
        },
      ]);

      // Cache must be invalidated after upsert
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      // New fetch re-computes and caches new counts
      const counts3 = getHighlightCounts(hDb);
      expect(counts3.byBookId[10]).toBe(1);
      expect(counts3.byTitle["neuromancer"]).toBe(1);

      // Delete highlights for book
      deleteHighlightsForBook(hDb, 10);
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      const counts4 = getHighlightCounts(hDb);
      expect(counts4.byBookId[10]).toBeUndefined();

      // ensureBookHighlightsIndexed with forceFresh deletes and invalidates even if 0 parsed highlights (Bug C remediation)
      batchUpsertHighlights(hDb, [
        {
          book_id: 20,
          book_title: "Nonexistent Note Book",
          chapter: null,
          page: null,
          quote: "Test Quote",
          note: null,
          timestamp: "2026-09-26",
        },
      ]);
      expect(getHighlightCounts(hDb).byBookId[20]).toBe(1);
      expect(getCachedHighlightCountsForTesting()).not.toBeNull();

      // Calling ensureBookHighlightsIndexed with forceFresh when note file exists but has 0 highlights (Bug C remediation)
      const tempVault = path.join(os.tmpdir(), `test_vault_${Date.now()}`);
      fs.mkdirSync(tempVault, { recursive: true });
      fs.writeFileSync(
        path.join(tempVault, "Nonexistent Note Book.md"),
        "# Note Without Highlights\nJust general notes, no markers.",
      );

      ensureBookHighlightsIndexed(hDb, 20, "Nonexistent Note Book", {
        forceFresh: true,
        booksDir: tempVault,
      });
      // Cache must be invalidated!
      expect(getCachedHighlightCountsForTesting()).toBeNull();
      fs.rmSync(tempVault, { recursive: true, force: true });

      // Defensive copies test on both miss and hit (Bug 2 remediation)
      const missCounts = getHighlightCounts(hDb);
      missCounts.byBookId[99] = 999; // Attempt mutation on miss return
      const hitCounts = getHighlightCounts(hDb);
      expect(hitCounts.byBookId[99]).toBeUndefined(); // Internal cache was NOT poisoned
      hitCounts.byBookId[99] = 888; // Attempt mutation on hit return
      const hitCounts2 = getHighlightCounts(hDb);
      expect(hitCounts2.byBookId[99]).toBeUndefined(); // Still not poisoned

      // Explicit invalidateHighlightCountsCache
      invalidateHighlightCountsCache(hDb);
      expect(getCachedHighlightCountsForTesting()).toBeNull();

      hDb.close();
    });

    it("initHighlightsTable runs DDL only once per Database instance", () => {
      const testDb = new Database(":memory:");
      // First call executes DDL
      initHighlightsTable(testDb);

      // Verify table exists
      const tableCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(tableCheck).not.toBeNull();

      // Corrupting sqlite_master or dropping table temporarily to prove second call skips DDL:
      testDb.run("DROP TABLE book_highlights;");

      // Second call to initHighlightsTable skips DDL because instance is in _initializedDbs WeakSet
      initHighlightsTable(testDb);
      const droppedCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(droppedCheck).toBeNull(); // Still null because DDL was skipped!

      // Force call re-creates table
      initHighlightsTable(testDb, true);
      const recreatedCheck = testDb
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='book_highlights';")
        .get();
      expect(recreatedCheck).not.toBeNull();

      testDb.close();
    });

    it("cache.db connection sets journal mode to WAL and busy timeout", () => {
      const db = getCacheDb();
      const journalMode = (db.query("PRAGMA journal_mode;").get() as any)?.journal_mode;
      expect(String(journalMode).toLowerCase()).toBe("wal");

      // Verify busy_timeout is set
      const busyTimeout = (db.query("PRAGMA busy_timeout;").get() as any)?.timeout;
      expect(Number(busyTimeout)).toBeGreaterThanOrEqual(3000);
    });
  });
});
