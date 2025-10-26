// api/ingest.js – Vercel Serverless Function
const cheerio = require('cheerio');

function detectSource(u=''){
  u = String(u).toLowerCase();
  if(u.includes('otodom')) return 'otodom';
  if(u.includes('olx')) return 'olx';
  if(u.includes('morizon')) return 'morizon';
  if(u.includes('gratka')) return 'gratka';
  return 'unknown';
}
function safeNum(t){
  if(typeof t !== 'string') t = String(t||'');
  const s = t.replace(/\s/g,'').replace(',', '.').replace(/[^\d.]/g,'');
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function normalize(listing){
  if(listing.price && listing.areaM2 && !listing.pricePerM2){
    const p = Number(listing.price), a = Number(listing.areaM2);
    if(a>0) listing.pricePerM2 = Math.round((p/a)*100)/100;
  }
  if(!listing.currency) listing.currency = 'PLN';
  if(Array.isArray(listing.images)){
    const set = new Set();
    listing.images.forEach(u=>{ try{ const url = new URL(u); url.search=''; set.add(url.toString()); }catch{ set.add(u); } });
    listing.images = Array.from(set);
  } else listing.images = [];
  return listing;
}
function scoreConfidence(l){
  let s = 0;
  if(l.title) s+=0.1;
  if(l.price) s+=0.15;
  if(l.areaM2) s+=0.15;
  if(l.rooms!==undefined) s+=0.1;
  if(l.locationText) s+=0.1;
  if(l.images && l.images.length>=2) s+=0.1;
  if(l.description && l.description.length>150) s+=0.05;
  if(l.pricePerM2) s+=0.1;
  s+= (l.latitude && l.longitude) ? 0.15 : 0;
  return Math.min(1, s);
}
function parseJSONLD($){
  const out = {}; const imgs = new Set();
  $('script[type="application/ld+json"]').each((_,el)=>{
    try{
      const txt = $(el).contents().text();
      const node = JSON.parse(txt);
      const arr = Array.isArray(node) ? node : [node];
      arr.forEach(obj=>{
        const get = (o,p)=>p.split('.').reduce((v,k)=>v?.[k], o);
        out.title = out.title || obj.name || obj.headline;
        out.description = out.description || obj.description;
        const price = get(obj, 'offers.price') ?? obj.price;
        const curr  = get(obj, 'offers.priceCurrency') ?? obj.priceCurrency;
        if(price) out.price = safeNum(String(price));
        if(curr)  out.currency = String(curr);
        const area = get(obj, 'floorSize.value') ?? obj.area ?? obj.size;
        if(area) out.areaM2 = safeNum(String(area));
        const rooms = obj.numberOfRooms ?? obj.rooms;
        if(rooms!=null) out.rooms = safeNum(String(rooms));
        const lat = get(obj,'geo.latitude') ?? get(obj,'geo.lat');
        const lng = get(obj,'geo.longitude') ?? get(obj,'geo.lng');
        if(lat && lng){ out.latitude = Number(String(lat).replace(',','.')); out.longitude = Number(String(lng).replace(',','.')); }
        out.locationText = out.locationText || get(obj,'address.addressLocality') || obj.address;
        const image = obj.image || obj.images || obj.photo;
        if(image){ (Array.isArray(image)?image:[image]).forEach(i=>imgs.add(String(i))); }
      });
    }catch{}
  });
  out.images = Array.from(imgs);
  return out;
}
function parseOpenGraph($){
  const meta = (sel)=> $('meta'+sel).attr('content');
  const out = {};
  out.title       = out.title || meta('[property="og:title"]') || meta('[name="twitter:title"]');
  out.description = out.description || meta('[property="og:description"]') || meta('[name="twitter:description"]');
  const img = meta('[property="og:image"]') || meta('[name="twitter:image"]');
  out.images = out.images || []; if(img) out.images.push(img);
  return out;
}
function heuristics($){
  const text = $('body').text().toLowerCase(); const out = {};
  const m2 = text.match(/(\d+[,\.\s]?\d*)\s*(m2|m²)/i); if(m2) out.areaM2 = safeNum(m2[1]);
  const price = text.match(/(\d[\d\s]{3,})\s*zł/i); if(price) out.price = safeNum(price[1]);
  const rooms = text.match(/(\d+)\s*(pokoi|pokoje|pokój|pok\.)/i); if(rooms) out.rooms = safeNum(rooms[1]);
  const loc = $('a[href*="map"], [data-cy="ad-location"]').first().text().trim() || $('h2:contains("lokalizacja"), h3:contains("lokalizacja")').next().text().trim();
  if(loc) out.locationText = out.locationText || loc;
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST { url, survey }' });
  }
  try{
    const chunks=[]; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    let body={}; try{ body=JSON.parse(raw);}catch{}
    const { url, survey = {} } = body;
    if(!url || typeof url !== 'string'){
      return res.status(400).json({ error:'Missing "url" in body' });
    }

    const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
    const r = await fetch(url, { headers: { 'user-agent': ua, 'accept-language':'pl,en;q=0.9' } });
    const html = await r.text();
    const $ = cheerio.load(html);

    let listing = { source: detectSource(url), url, images: [] };
    listing = { ...listing, ...parseJSONLD($) };
    listing = { ...parseOpenGraph($), ...listing };
    listing = { ...listing, ...heuristics($) };
    listing = normalize(listing);
    listing.fetchedAtISO = new Date().toISOString();
    listing.parseConfidence = scoreConfidence(listing);

    return res.status(200).json({ data: { listing, survey, scores: {} } });
  }catch(err){
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
