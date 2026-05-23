// ---- YOUR KEYS ----
const SUPABASE_URL = 'https://ufqlbzxgclgkzhtknvgj.supabase.co';
const SUPABASE_KEY = 'YOUR_SUPABASE_SECRET_KEY'; // ← replace before running
const GOOGLE_KEY   = 'AIzaSyC0OrtfHpAEGBI6oRVU3BN11WFEb6fvVO0';       // ← replace before running

const delay = ms => new Promise(r => setTimeout(r, ms));

// Fetch all cafes that have a google_place_id but no opening_hours yet
async function fetchCafes() {
  console.log('📋 Fetching cafés without hours...');
  const all = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cafes?select=id,name,google_place_id&opening_hours=is.null&google_place_id=not.is.null&limit=${pageSize}&offset=${offset}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`   Found ${all.length} cafés to update\n`);
  return all;
}

async function getOpeningHours(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=opening_hours&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') return null;
  return data.result?.opening_hours || null;
}

async function updateCafeHours(id, hours) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cafes?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ opening_hours: hours })
  });
  return res.ok;
}

async function run() {
  console.log('⏰ CoffIE Hours Backfill\n');

  const cafes = await fetchCafes();
  if (!cafes.length) {
    console.log('✅ All cafés already have hours!');
    return;
  }

  let updated = 0;
  let noHours = 0;
  let errors = 0;

  for (let i = 0; i < cafes.length; i++) {
    const cafe = cafes[i];
    process.stdout.write(`[${i+1}/${cafes.length}] ${cafe.name}... `);

    const hours = await getOpeningHours(cafe.google_place_id);

    if (!hours) {
      process.stdout.write(`⚠️  no hours\n`);
      noHours++;
      // Still update with empty object so we don't retry it repeatedly
      await updateCafeHours(cafe.id, {});
    } else {
      const ok = await updateCafeHours(cafe.id, hours);
      if (ok) {
        process.stdout.write(`✅\n`);
        updated++;
      } else {
        process.stdout.write(`❌ update failed\n`);
        errors++;
      }
    }

    await delay(120); // stay well under Google's rate limit
  }

  console.log('\n' + '═'.repeat(40));
  console.log(`✅ Updated with hours:  ${updated}`);
  console.log(`⚠️  No hours available: ${noHours}`);
  console.log(`❌ Errors:              ${errors}`);
  console.log('═'.repeat(40));
  console.log('🎉 Done!');
}

run().catch(console.error);
