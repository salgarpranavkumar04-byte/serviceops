'use strict';

/**
 * services/geocode.service.js — Google Maps geocoding helpers (v5) NEW
 *
 * Extracted from server.js.
 *
 * Provides:
 *   reverseGeocode(lat, lng)      — lat/lng → formatted address string
 *   geocodeAddress(address)       — address string → { lat, lng, formatted_address }
 *
 * Both functions return null (never throw) when the API key is missing
 * or when Google returns an error, so callers can treat geocoding as optional.
 */

const axios = require('axios');

const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS   = 5_000;

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[geocode]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[geocode][error]', msg, ...meta }));
}

/**
 * Reverse geocode — lat/lng → human-readable address.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string|null>}
 */
async function reverseGeocode(lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get(GEOCODE_BASE, {
      params:  { latlng: `${lat},${lng}`, key: apiKey },
      timeout: TIMEOUT_MS,
    });
    const result = response.data?.results?.[0];
    const address = result?.formatted_address || null;
    if (address) log('Reverse geocode OK', { lat, lng, address: address.slice(0, 60) });
    return address;
  } catch (err) {
    logError('reverseGeocode failed', { lat, lng, err: err.message });
    return null;
  }
}

/**
 * Forward geocode — address string → coordinates.
 *
 * @param {string} address
 * @returns {Promise<{ lat: number, lng: number, formatted_address: string }|null>}
 */
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get(GEOCODE_BASE, {
      params:  { address, key: apiKey },
      timeout: TIMEOUT_MS,
    });
    const data = response.data;
    if (data?.status !== 'OK' || !data?.results?.length) return null;
    const location = data.results[0]?.geometry?.location;
    if (!location) return null;
    return {
      lat:               location.lat,
      lng:               location.lng,
      formatted_address: data.results[0].formatted_address,
    };
  } catch (err) {
    logError('geocodeAddress failed', { address: address.slice(0, 60), err: err.message });
    return null;
  }
}

module.exports = { reverseGeocode, geocodeAddress };
