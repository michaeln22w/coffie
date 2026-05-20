const { createClient } = require('@supabase/supabase-js');

// ---- YOUR KEYS ----
const SUPABASE_URL = 'https://ufqlbzxgclgkzhtknvgj.supabase.co';
const SUPABASE_KEY = 'YOUR_SECRET_KEY_HERE';
const GOOGLE_KEY = 'AIzaSyBpc1VsFUdzCrUzeSYzaO2ofk--DiN9roo';

// Irish cities to search across
const searches = [
  'cafes in Dublin, Ireland',
  'cafes in Cork, Ireland',
  'cafes in Galway, Ireland',
  'cafes in Limerick, Ireland',
  'cafes in Waterford, Ireland',
  'cafes in Kilkenny, Ireland',
  'cafes in Sligo, Ireland',
  'cafes in Drogheda, Ireland',
  'cafes in Athlone, Ireland',
  'cafes in Wexford, Ireland',
];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function searchPlaces(query) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(`Search error for "${query}":`, data.status, data.error_message);
    return [];
  }
  return data.results || [];
}

async function getPlaceDetails(placeId) {
  const fields = 'name,formatted_address,geometry,rating,user_ratings_total,opening_hours,website,formatted_phone_number,price_level,types,photos';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') {
    console.error(`Details error for ${placeId}:`, data.status);
    return null;
  }
  return data.result;
}

async function insertCafe(place, details) {
  const types = details?.types || place.types || [];
  let type = 'indie';
  const chainNames = ['starbucks', 'costa', 'insomnia', 'mcdonalds', 'kfc', 'subway', 'circle k', 'applegreen', 'maxol', 'texaco', 'topaz'];
  const nameLower = (place.name || '').toLowerCase();
  if (chainNames.some(c => nameLower.includes(c))) type = 'chain';
  if (types.includes('gas_station') || types.includes('convenience_store')) type = 'petrol';

  const cafe = {
    name: place.name,
    address: place.formatted_address || details?.formatted_address || '',
    lat: place.geometry?.location?.lat || details?.geometry?.location?.lat,
    lng: place.geometry?.location?.lng || details?.geometry?.location?.lng,
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
    console.error('Insert error:', err);
    return null;
  }

  const data = await res.json();
  return data[0] || null;
}

async function run() {
  console.log('☕ CoffIE Seed Script Starting...\n');

  let totalInserted = 0;
  const seenPlaceIds = new Set();

  for (const query of searches) {
    console.log(`🔍 Searching: ${query}`);
    const places = await searchPlaces(query);
    console.log(`   Found ${places.length} places`);

    for (const place of places) {
      if (seenPlaceIds.has(place.place_id)) continue;
      seenPlaceIds.add(place.place_id);

      await delay(100);
      const details = await getPlaceDetails(place.place_id);

      const inserted = await insertCafe(place, details);
      if (inserted) {
        totalInserted++;
        console.log(`   ✅ ${place.name} — ${place.formatted_address}`);
      }
    }

    await delay(500);
    console.log('');
  }

  console.log(`\n🎉 Done! Inserted ${totalInserted} cafés into CoffIE database.`);
}

run().catch(console.error);
