import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const NOMINATIM_URL =
  process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/reverse"
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  `icloud-to-r2/1.0${process.env.GITHUB_REPO ? ` (${process.env.GITHUB_REPO})` : ""}`

const IMAGE_METADATA_KEYS = ["width", "height", "blur"]
const nominatimCache = new Map()
let lastNominatimRequestAt = 0

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {unknown} value */
function cleanMetadataValue(value) {
  if (value === undefined || value === null) return undefined
  const stringValue = String(value).trim()
  return stringValue || undefined
}

/**
 * Merge generated upload metadata into existing R2 metadata without dropping
 * unrelated keys already attached to the object.
 * @param {Record<string, unknown>} existing
 * @param {Record<string, unknown>} generated
 * @returns {Record<string, string>}
 */
export function mergeObjectMetadata(existing = {}, generated = {}) {
  /** @type {Record<string, string>} */
  const merged = {}

  for (const [key, value] of Object.entries(existing)) {
    const cleanValue = cleanMetadataValue(value)
    if (cleanValue) merged[key] = cleanValue
  }

  for (const [key, value] of Object.entries(generated)) {
    const cleanValue = cleanMetadataValue(value)
    if (cleanValue) merged[key] = cleanValue
  }

  return merged
}

/**
 * @param {Record<string, unknown>} existing
 * @param {Record<string, unknown>} generated
 */
export function metadataNeedsUpdate(existing = {}, generated = {}) {
  for (const key of IMAGE_METADATA_KEYS) {
    if (!cleanMetadataValue(existing[key])) return true
  }

  for (const [key, value] of Object.entries(generated)) {
    const cleanValue = cleanMetadataValue(value)
    if (!cleanValue) continue
    if (cleanMetadataValue(existing[key]) !== cleanValue) return true
  }

  return false
}

/** @param {Record<string, unknown>} tags */
export function parseDateOnly(tags = {}) {
  for (const key of ["DateTimeOriginal", "CreateDate", "GPSDateStamp"]) {
    const value = cleanMetadataValue(tags[key])
    if (!value) continue

    const match = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/)
    if (match) return `${match[1]}-${match[2]}-${match[3]}`
  }

  return undefined
}

/** @param {unknown[]} values */
function firstCleanValue(values) {
  for (const value of values) {
    const cleanValue = cleanMetadataValue(value)
    if (cleanValue) return cleanValue
  }
  return undefined
}

/** @param {string | undefined} country */
function normalizeCountry(country) {
  if (!country) return undefined
  if (/^(south korea|republic of korea|대한민국)$/i.test(country)) return "Korea"
  return country
}

/**
 * Convert a Nominatim response into coarse administrative metadata only.
 * @param {{ address?: Record<string, unknown> } | undefined} response
 * @returns {Record<string, string>}
 */
export function buildCoarseGeoMetadata(response) {
  const address = response?.address ?? {}
  const country = normalizeCountry(cleanMetadataValue(address.country))
  const region = firstCleanValue([
    address.state,
    address.province,
    address.region,
  ])
  const city = firstCleanValue([
    address.city,
    address.town,
    address.village,
    address.municipality,
  ])
  const district = firstCleanValue([
    address.city_district,
    address.borough,
    address.suburb,
    address.county,
  ])

  /** @type {Record<string, string>} */
  const metadata = {}
  if (country) metadata["geo-country"] = country
  if (region) metadata["geo-region"] = region
  if (city) metadata["geo-city"] = city
  if (district) metadata["geo-district"] = district

  const labelParts = []
  for (const value of [country, region, city, district]) {
    if (!value) continue
    const previous = labelParts.at(-1)
    if (previous?.toLowerCase() === value.toLowerCase()) continue
    labelParts.push(value)
  }

  if (labelParts.length > 0) metadata["geo-label"] = labelParts.join(", ")
  return metadata
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** @param {number} coordinate */
function coarseCoordinate(coordinate) {
  return Number(coordinate.toFixed(3))
}

async function waitForNominatimSlot() {
  const elapsed = Date.now() - lastNominatimRequestAt
  if (elapsed < 1000) await delay(1000 - elapsed)
  lastNominatimRequestAt = Date.now()
}

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{ fetchImpl?: typeof fetch }} options
 */
async function reverseGeocode(latitude, longitude, { fetchImpl = fetch } = {}) {
  const coarseLatitude = coarseCoordinate(latitude)
  const coarseLongitude = coarseCoordinate(longitude)
  const cacheKey = `${coarseLatitude},${coarseLongitude}`
  if (nominatimCache.has(cacheKey)) return nominatimCache.get(cacheKey)

  await waitForNominatimSlot()

  const url = new URL(NOMINATIM_URL)
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("addressdetails", "1")
  url.searchParams.set("zoom", "12")
  url.searchParams.set("layer", "address")
  url.searchParams.set("accept-language", "en")
  url.searchParams.set("lat", String(coarseLatitude))
  url.searchParams.set("lon", String(coarseLongitude))

  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": NOMINATIM_USER_AGENT,
    },
  })

  if (!response.ok) {
    throw new Error(`Nominatim reverse geocode failed: ${response.status}`)
  }

  const body = await response.json()
  nominatimCache.set(cacheKey, body)
  return body
}

/** @param {string} filePath */
export async function readExifTags(filePath) {
  const { stdout } = await execFileAsync(
    "exiftool",
    [
      "-json",
      "-n",
      "-DateTimeOriginal",
      "-CreateDate",
      "-GPSDateStamp",
      "-GPSLatitude",
      "-GPSLongitude",
      filePath,
    ],
    { maxBuffer: 1024 * 1024 },
  )

  const parsed = JSON.parse(stdout)
  return parsed[0] ?? {}
}

/**
 * @param {string} filePath
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   readExifTagsImpl?: typeof readExifTags,
 *   warn?: (message: string) => void,
 * }} options
 */
export async function getExifDerivedMetadata(
  filePath,
  { fetchImpl = fetch, readExifTagsImpl = readExifTags, warn = () => {} } = {},
) {
  let tags
  try {
    tags = await readExifTagsImpl(filePath)
  } catch (err) {
    warn(`EXIF read skipped for ${filePath}: ${err?.message ?? err}`)
    return {}
  }

  /** @type {Record<string, string>} */
  const metadata = {}
  const takenDate = parseDateOnly(tags)
  if (takenDate) metadata["taken-date"] = takenDate

  const latitude = finiteNumber(tags.GPSLatitude)
  const longitude = finiteNumber(tags.GPSLongitude)
  if (latitude === undefined || longitude === undefined) return metadata

  try {
    Object.assign(
      metadata,
      buildCoarseGeoMetadata(
        await reverseGeocode(latitude, longitude, { fetchImpl }),
      ),
    )
  } catch (err) {
    warn(`Reverse geocode skipped for ${filePath}: ${err?.message ?? err}`)
  }

  return metadata
}
