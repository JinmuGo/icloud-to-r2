import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildCoarseGeoMetadata,
  getExifDerivedMetadata,
  mergeObjectMetadata,
  metadataNeedsUpdate,
  parseDateOnly,
} from "./metadata.js"

test("parseDateOnly extracts date without time from common EXIF date tags", () => {
  assert.equal(
    parseDateOnly({
      DateTimeOriginal: "2023:10:01 21:49:48",
      CreateDate: "2022:09:03 10:11:12",
      GPSDateStamp: "2021:08:07",
    }),
    "2023-10-01",
  )

  assert.equal(
    parseDateOnly({
      GPSDateStamp: "2023:10:01",
    }),
    "2023-10-01",
  )
})

test("buildCoarseGeoMetadata keeps only administrative location names", () => {
  const metadata = buildCoarseGeoMetadata({
    address: {
      country: "South Korea",
      state: "Seoul",
      city: "Seoul",
      city_district: "Dongdaemun-gu",
      road: "Some exact street",
      house_number: "123",
    },
  })

  assert.deepEqual(metadata, {
    "geo-country": "Korea",
    "geo-region": "Seoul",
    "geo-city": "Seoul",
    "geo-district": "Dongdaemun-gu",
    "geo-label": "Korea, Seoul, Dongdaemun-gu",
  })
})

test("mergeObjectMetadata preserves unrelated existing metadata", () => {
  assert.deepEqual(
    mergeObjectMetadata(
      {
        width: "100",
        height: "200",
        blur: "old-blur",
        custom: "keep-me",
        "geo-label": "old place",
      },
      {
        width: "300",
        height: "400",
        blur: "new-blur",
        "taken-date": "2023-10-01",
        "geo-label": "Korea, Seoul, Dongdaemun-gu",
      },
    ),
    {
      width: "300",
      height: "400",
      blur: "new-blur",
      custom: "keep-me",
      "taken-date": "2023-10-01",
      "geo-label": "Korea, Seoul, Dongdaemun-gu",
    },
  )
})

test("metadataNeedsUpdate only requires EXIF fields that were derived", () => {
  assert.equal(
    metadataNeedsUpdate(
      { width: "300", height: "400", blur: "blur" },
      { width: "300", height: "400", blur: "blur" },
    ),
    false,
  )

  assert.equal(
    metadataNeedsUpdate(
      { width: "300", height: "400", blur: "blur" },
      { width: "300", height: "400", blur: "blur", "taken-date": "2023-10-01" },
    ),
    true,
  )

  assert.equal(
    metadataNeedsUpdate(
      {
        width: "300",
        height: "400",
        blur: "blur",
        "taken-date": "2023-10-01",
      },
      { width: "300", height: "400", blur: "blur", "taken-date": "2023-10-01" },
    ),
    false,
  )
})

test("getExifDerivedMetadata builds date and coarse geo without storing coordinates", async () => {
  let requestedUrl

  const metadata = await getExifDerivedMetadata("/photo.jpg", {
    readExifTagsImpl: async () => ({
      DateTimeOriginal: "2023:10:01 21:49:48",
      GPSLatitude: 37.574123,
      GPSLongitude: 127.039456,
    }),
    fetchImpl: async (url) => {
      requestedUrl = url
      return {
        ok: true,
        json: async () => ({
          address: {
            country: "South Korea",
            state: "Seoul",
            city: "Seoul",
            city_district: "Dongdaemun-gu",
            road: "Some exact street",
          },
        }),
      }
    },
  })

  assert.equal(requestedUrl.searchParams.get("lat"), "37.574")
  assert.equal(requestedUrl.searchParams.get("lon"), "127.039")
  assert.deepEqual(metadata, {
    "taken-date": "2023-10-01",
    "geo-country": "Korea",
    "geo-region": "Seoul",
    "geo-city": "Seoul",
    "geo-district": "Dongdaemun-gu",
    "geo-label": "Korea, Seoul, Dongdaemun-gu",
  })
  assert.equal("GPSLatitude" in metadata, false)
  assert.equal("GPSLongitude" in metadata, false)
})

test("getExifDerivedMetadata keeps date when reverse geocoding fails", async () => {
  const warnings = []

  const metadata = await getExifDerivedMetadata("/photo.jpg", {
    readExifTagsImpl: async () => ({
      DateTimeOriginal: "2023:10:01 21:49:48",
      GPSLatitude: 35.1796,
      GPSLongitude: 129.0756,
    }),
    fetchImpl: async () => ({
      ok: false,
      status: 503,
    }),
    warn: (message) => warnings.push(message),
  })

  assert.deepEqual(metadata, { "taken-date": "2023-10-01" })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Reverse geocode skipped/)
})
