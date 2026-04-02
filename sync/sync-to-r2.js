import fs from "node:fs/promises"
import path from "node:path"
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { globby } from "globby"
import { getPlaiceholder } from "plaiceholder"
import sharp from "sharp"

// --- Configuration ---

const PHOTOS_DIR = process.env.PHOTOS_DIR ?? "/photos"
const BUCKET_NAME = requiredEnv("R2_BUCKET_NAME")
const BUCKET_PREFIX = process.env.R2_BUCKET_PREFIX ?? ""
const ACCOUNT_ID = requiredEnv("R2_ACCOUNT_ID")
const ACCESS_KEY_ID = requiredEnv("R2_ACCESS_KEY_ID")
const SECRET_ACCESS_KEY = requiredEnv("R2_SECRET_ACCESS_KEY")

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? ""
const GITHUB_REPO = process.env.GITHUB_REPO ?? ""
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW ?? "astro.yaml"

const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL ?? "7200") * 1000

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

// --- S3 Client ---

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
})

// --- Helpers ---

/** @param {string} name */
function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

function timestamp() {
  return new Date().toISOString()
}

/**
 * List all existing object keys in R2 under the configured prefix.
 * Handles pagination for buckets with >1000 objects.
 * @returns {Promise<Set<string>>}
 */
async function listExistingKeys() {
  const keys = new Set()
  let continuationToken

  do {
    /** @type {import("@aws-sdk/client-s3").ListObjectsV2CommandOutput} */
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: BUCKET_PREFIX ? `${BUCKET_PREFIX}/` : undefined,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key)
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)

  return keys
}

/**
 * Check if an object already has metadata (width, height, blur).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function hasMetadata(key) {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
    )
    const meta = head.Metadata ?? {}
    return Boolean(meta.width && meta.height && meta.blur)
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") {
      return false
    }
    throw err
  }
}

/**
 * Convert HEIC to JPEG buffer using sharp.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function convertHeicToJpeg(buffer) {
  return sharp(buffer).jpeg({ quality: 90 }).toBuffer()
}

/**
 * Extract image metadata using plaiceholder.
 * Handles EXIF orientation for correct width/height.
 * Converts HEIC to JPEG automatically.
 * @param {string} filePath
 */
async function getImageMeta(filePath) {
  let buffer = await fs.readFile(filePath)
  const isHeic = path.extname(filePath).toLowerCase() === ".heic"

  if (isHeic) {
    buffer = await convertHeicToJpeg(buffer)
  }

  const {
    base64,
    metadata: { width, height, orientation },
  } = await getPlaiceholder(buffer)

  // Swap width/height for rotated images (EXIF orientation >= 5)
  const finalWidth = orientation && orientation >= 5 ? height : width
  const finalHeight = orientation && orientation >= 5 ? width : height

  return { width: finalWidth, height: finalHeight, blur: base64, buffer }
}

/**
 * Upload a single image to R2 with metadata.
 * @param {string} filePath - Absolute path to the local file
 * @param {string} r2Key - The R2 object key
 * @returns {Promise<boolean>} - Whether the upload succeeded
 */
async function uploadImage(filePath, r2Key) {
  try {
    const { width, height, blur, buffer } = await getImageMeta(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const contentType = ext === ".heic" ? "image/jpeg" : (CONTENT_TYPES[ext] ?? "application/octet-stream")

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: r2Key,
        Body: buffer,
        ContentType: contentType,
        Metadata: {
          width: String(width),
          height: String(height),
          blur,
        },
      }),
    )

    console.log(`[${timestamp()}] uploaded: ${r2Key} (${width}x${height})`)
    return true
  } catch (err) {
    console.error(`[${timestamp()}] failed: ${r2Key}`, err?.message ?? err)
    return false
  }
}

/**
 * Trigger a GitHub Actions workflow_dispatch.
 * @returns {Promise<boolean>}
 */
async function triggerGitHubRebuild() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log(`[${timestamp()}] GitHub dispatch skipped (not configured)`)
    return false
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    })

    if (response.ok || response.status === 204) {
      console.log(`[${timestamp()}] GitHub Actions dispatch triggered`)
      return true
    }

    const body = await response.text()
    console.error(
      `[${timestamp()}] GitHub dispatch failed (${response.status}): ${body}`,
    )
    return false
  } catch (err) {
    console.error(
      `[${timestamp()}] GitHub dispatch error:`,
      err?.message ?? err,
    )
    return false
  }
}

// --- Main sync loop ---

async function sync() {
  console.log(`[${timestamp()}] Starting sync...`)
  console.log(`  Photos dir: ${PHOTOS_DIR}`)
  console.log(`  R2 bucket:  ${BUCKET_NAME}/${BUCKET_PREFIX ? `${BUCKET_PREFIX}/` : ""}`)

  // 1. Scan local photos
  const patterns = IMAGE_EXTENSIONS.map((ext) => `**/*${ext}`)
  const localFiles = await globby(patterns, {
    cwd: PHOTOS_DIR,
    caseSensitiveMatch: false,
  })

  if (localFiles.length === 0) {
    console.log(`[${timestamp()}] No local photos found. Waiting...`)
    return
  }

  console.log(`[${timestamp()}] Found ${localFiles.length} local photos`)

  // 2. List existing R2 objects
  const existingKeys = await listExistingKeys()
  console.log(
    `[${timestamp()}] Found ${existingKeys.size} existing R2 objects`,
  )

  // 3. Find new files to upload
  let uploadCount = 0
  let skipCount = 0

  for (const relPath of localFiles) {
    const normalized = relPath.replace(/\\/g, "/")
    // HEIC files are converted to JPEG, so use .jpg extension in R2
    const r2Path = normalized.replace(/\.heic$/i, ".jpg")
    const r2Key = BUCKET_PREFIX ? `${BUCKET_PREFIX}/${r2Path}` : r2Path
    const absPath = path.join(PHOTOS_DIR, relPath)

    // Skip if already exists with metadata
    if (existingKeys.has(r2Key) && (await hasMetadata(r2Key))) {
      skipCount++
      continue
    }

    const ok = await uploadImage(absPath, r2Key)
    if (ok) uploadCount++
  }

  console.log(
    `[${timestamp()}] Sync complete: ${uploadCount} uploaded, ${skipCount} skipped`,
  )

  // 4. Trigger rebuild if new uploads
  if (uploadCount > 0) {
    await triggerGitHubRebuild()
  }
}

// --- Entry point ---

console.log(`[${timestamp()}] icloud-photo-sync started`)
console.log(`  Sync interval: ${SYNC_INTERVAL / 1000}s`)

// Run immediately, then on interval
try {
  await sync()
} catch (err) {
  console.error(`[${timestamp()}] Sync error:`, err?.message ?? err)
}

setInterval(async () => {
  try {
    await sync()
  } catch (err) {
    console.error(`[${timestamp()}] Sync error:`, err?.message ?? err)
  }
}, SYNC_INTERVAL)
