const { createClient } = require('@supabase/supabase-js');

// ---- YOUR KEYS ----
const SUPABASE_URL = 'https://ufqlbzxgclgkzhtknvgj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bxr5571LFdx6g1vxQrC7WA_ijowQpAp'; // ← replace before running
const GOOGLE_KEY = 'AIzaSyC0OrtfHpAEGBI6oRVU3BN11WFEb6fvVO0';         // ← replace before running

// ---- GRID CONFIG ----
const LAT_MIN = 51.4;
const LAT_MAX = 55.4;
const LNG_MIN = -10.5;
const LNG_MAX = -5.5;
const STEP = 0.45;       // ~50km — full island coverage
const RADIUS = 30000;    // 30km radius

// ---- CITY DENSE GRIDS ----
const CITY_GRIDS = [
  { name: 'Dublin',  latMin: 53.28, latMax: 53.42, lngMin: -6.42, lngMax: -6.10 },
  { name: 'Cork',    latMin: 51.87, latMax: 51.92, lngMin: -8.52, lngMax: -8.40 },
  { name: 'Galway',  latMin: 53.26, latMax: 53.30, lngMin: -9.10, lngMax: -8.98 },
  { name: 'Limerick',latMin: 52.65, latMax: 52.68, lngMin: -8.65, lngMax: -8.60 },
  { name: 'Waterford',latMin: 52.25, latMax: 52.27, lngMin: -7.13, lngMax: -7.08 },
];
const CITY_STEP = 0.012;   // ~1.3km — tight grid for cities
const CITY_RADIUS = 1000;  // 1km radius (dense, overlapping)

// ---- PLACE TYPES TO SEARCH ----
const PLACE_TYPES = ['cafe', 'bakery'];

function buildGrid(latMin, latMax, lngMin, lngMax, step) {
  const points = [];
  for (let lat = latMin; lat <= latMax; lat += step) {
    for (let lng = lngMin; lng <= lngMax; lng += step) {
      points.push({ lat: parseFloat(lat.toFixed(5)), lng: parseFloat(lng.toFixed(5)) });
    }
  }
  return points;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function nearbySearch(lat, lng, type, radius, pageToken = null) {
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${GOOGLE_KEY}`;
  if (pageToken) url += `&pagetoken=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(`  Search error (${lat},${lng}) type=${type}:`, data.status, data.error_message || '');
    return { results: [], nextPageToken: null };
  }
  return { results: data.results || [], nextPageToken: data.next_page_token || null };
}

async function getAllResultsForPoint(lat, lng, type, radius) {
  const allResults = [];
  let pageToken = null;
  let page = 0;
  do {
    if (pageToken) await delay(2200);
    const { results, nextPageToken } = await nearbySearch(lat, lng, type, radius, pageToken);
    allResults.push(...results);
    pageToken = nextPageToken;
    page++;
  } while (pageToken && page < 3);
  return allResults;
}

async function getPlaceDetails(placeId) {
  const fields = 'name,formatted_address,geometry,rating,user_ratings_total,opening_hours,website,formatted_phone_number,types';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') return null;
  return data.result;
}

async function insertCafe(place, details) {
  const types = details?.types || place.types || [];
  let type = 'indie';
  const chainNames = ['starbucks', 'costa', 'insomnia', "mcdonald's", 'mcdonalds', 'kfc', 'subway',
                      'circle k', 'applegreen', 'maxol', 'texaco', 'topaz', 'centra', 'spar', 'supervalu', 'greggs'];
  const nameLower = (place.name || '').toLowerCase();
  if (chainNames.some(c => nameLower.includes(c))) type = 'chain';
  if (types.includes('gas_station') || types.includes('convenience_store')) type = 'petrol';

  const cafe = {
    name: place.name,
    address: place.vicinity || details?.formatted_address || '',
    lat: place.geometry?.location?.lat,
    lng: place.geometry?.location?.lng,
    type,
    google_place_id: place.place_id,
    phone: details?.formatted_phone_number || null,
    website: details?.website || null,
    featured: false,
    claimed: false,
  };

  if (!cafe.lat || !cafe.lng) return null;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/cafes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation,resolution=ignore-duplicates'
    },
    body: JSON.stringify(cafe)
  });

  if (!res.ok) {
    const err = await res.text();
    if (!err.includes('duplicate') && !err.includes('unique')) {
      console.error('  Insert error:', err);
    }
    return null;
  }

  const data = await res.json();
  return data[0] || null;
}

async function fetchExistingPlaceIds() {
  console.log('📋 Fetching existing place IDs from database...');
  const existing = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cafes?select=google_place_id&limit=${pageSize}&offset=${offset}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    data.forEach(row => { if (row.google_place_id) existing.add(row.google_place_id); });
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`   ${existing.size} existing cafés in DB\n`);
  return existing;
}

async function runPass(label, points, types, radius, existingPlaceIds, seenThisRun, counters) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`🔍 ${label} — ${points.length} points × ${types.length} types`);
  console.log(`${'─'.repeat(50)}\n`);

  let pointsDone = 0;
  for (const { lat, lng } of points) {
    pointsDone++;
    for (const type of types) {
      process.stdout.write(`[${pointsDone}/${points.length}] (${lat}, ${lng}) type=${type}... `);
      const places = await getAllResultsForPoint(lat, lng, type, radius);
      process.stdout.write(`${places.length} found\n`);

      for (const place of places) {
        const pid = place.place_id;
        if (existingPlaceIds.has(pid)) { counters.skippedDB++; continue; }
        if (seenThisRun.has(pid))      { counters.skippedRun++; continue; }
        seenThisRun.add(pid);

        await delay(80);
        const details = await getPlaceDetails(pid);
        const inserted = await insertCafe(place, details);
        if (inserted) {
          counters.inserted++;
          existingPlaceIds.add(pid); // prevent re-insert in later passes
          console.log(`   ✅ ${place.name}`);
        }
      }
      await delay(300);
    }
  }
}

async function run() {
  console.log('☕ CoffIE Seed v2 — Grid + City Dense Pass\n');

  const existingPlaceIds = await fetchExistingPlaceIds();
  const seenThisRun = new Set();
  const counters = { inserted: 0, skippedDB: 0, skippedRun: 0 };

  // ── PASS 1: Full island grid, bakery type (cafe already done in v1) ──
  const islandGrid = buildGrid(LAT_MIN, LAT_MAX, LNG_MIN, LNG_MAX, STEP);
  await runPass('Island grid — bakery', islandGrid, ['bakery'], RADIUS, existingPlaceIds, seenThisRun, counters);

  // ── PASS 2: City dense grids, both types ──
  for (const city of CITY_GRIDS) {
    const cityPoints = buildGrid(city.latMin, city.latMax, city.lngMin, city.lngMax, CITY_STEP);
    await runPass(`${city.name} dense grid`, cityPoints, PLACE_TYPES, CITY_RADIUS, existingPlaceIds, seenThisRun, counters);
  }

  console.log('\n' + '═'.repeat(40));
  console.log(`✅ Inserted:          ${counters.inserted}`);
  console.log(`⏭️  Skipped (in DB):   ${counters.skippedDB}`);
  console.log(`⏭️  Skipped (in run):  ${counters.skippedRun}`);
  console.log('═'.repeat(40));
  console.log('🎉 Done!');
}

run().catch(console.error);
