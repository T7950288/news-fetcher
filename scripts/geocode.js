// geocode.js - 批量地理编码 county-placeholder 景点
// 在 GitHub Actions 云端运行，通过 GitHub API 提交结果
const https = require('https');
const fs = require('fs');

const GH_TOKEN = process.env.GH_TOKEN;
const REPO = 't7950288/news-fetcher';
const BRANCH = 'main';
const FILE_PATH = 'travel/data_bundle.js';

// WGS-84 to GCJ-02
const PI = 3.1415926535897932384626;
const A = 6378245.0;
const EE = 0.00669342162296594323;
function outOfChina(lat, lng) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function transformLat(x, y) {
  let ret = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  ret += (20.0*Math.sin(6.0*x*PI) + 20.0*Math.sin(2.0*x*PI)) * 2.0/3.0;
  ret += (20.0*Math.sin(y*PI) + 40.0*Math.sin(y/3.0*PI)) * 2.0/3.0;
  ret += (160.0*Math.sin(y/12.0*PI) + 320*Math.sin(y*PI/30.0)) * 2.0/3.0;
  return ret;
}
function transformLon(x, y) {
  let ret = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  ret += (20.0*Math.sin(6.0*x*PI) + 20.0*Math.sin(2.0*x*PI)) * 2.0/3.0;
  ret += (20.0*Math.sin(x*PI) + 40.0*Math.sin(x/3.0*PI)) * 2.0/3.0;
  ret += (150.0*Math.sin(x/12.0*PI) + 300.0*Math.sin(x/30.0*PI)) * 2.0/3.0;
  return ret;
}
function wgs2gcj(wlat, wlng) {
  if (outOfChina(wlat, wlng)) return [wlat, wlng];
  let dLat = transformLat(wlng - 105.0, wlat - 35.0);
  let dLon = transformLon(wlng - 105.0, wlat - 35.0);
  const radLat = wlat / 180.0 * PI;
  let magic = Math.sin(radLat); magic = 1 - EE*magic*magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLon = (dLon * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [wlat + dLat, wlng + dLon];
}

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : require('http');
    const req = lib.request(url, { headers: { 'User-Agent': 'TravelMapGeocoder/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function nominatimSearch(name, city, county) {
  // Build query: try several combinations
  const queries = [
    `${name} ${city}`,
    `${name} ${county} ${city}`,
    `${name}`,
  ];
  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=zh&q=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        if (j && j.length > 0) {
          return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), display: j[0].display_name };
        }
      }
    } catch(e) {}
    await sleep(1100); // Nominatim rate limit: 1/sec
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ghApi(path, method = 'GET', body = null) {
  const opts = {
    hostname: 'api.github.com', path: path, method,
    headers: {
      'Authorization': 'Bearer ' + GH_TOKEN,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'TravelMapBot',
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} }); }
        catch(e) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : null);
  });
}

async function main() {
  console.log('=== Travel Map Geocoder ===');

  // 1. Download current data_bundle.js
  console.log('Downloading data_bundle.js...');
  const dl = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE_PATH}`);
  let code = dl.body;

  // Parse
  const m = code.match(/window\.APP_DATA\s*=\s*/);
  const jsStart = m.index + m[0].length;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = jsStart; i < code.length; i++) {
    const c = code[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i+1; break; } }
  }
  const data = JSON.parse(code.substring(jsStart, end));
  console.log('Loaded', data.attractions.length, 'attractions');

  // 2. Find county placeholders
  const todos = data.attractions.filter(s => s.coord_src === 'county');
  console.log('To geocode:', todos.length);

  // 3. Geocode each
  let fixed = 0, failed = 0;
  for (let i = 0; i < todos.length; i++) {
    const spot = todos[i];
    const result = await nominatimSearch(spot.name, spot.city, spot.county || '');
    if (result) {
      // Convert WGS-84 to GCJ-02
      const [glat, glng] = wgs2gcj(result.lat, result.lon);
      spot.lng = Math.round(glng * 10000) / 10000;
      spot.lat = Math.round(glat * 10000) / 10000;
      delete spot.coord_src;
      fixed++;
      if (fixed % 50 === 0) console.log(`Progress: ${i+1}/${todos.length}, fixed=${fixed}, failed=${failed}`);
    } else {
      failed++;
    }
  }
  console.log(`Done: fixed=${fixed}, failed=${failed}, total=${todos.length}`);

  // 4. Repack
  const newCode = '// 自动生成，请勿手改。景点 ' + data.attractions.length + ' 个，市级 ' + (data.cities?.cities?.length||0) + ' 个，县级 ' + (data.cities?.counties?.length||0) + ' 个。\n'
    + 'window.APP_DATA = ' + JSON.stringify(data) + ';\n';

  // 5. Upload to GitHub
  console.log('Uploading result...');
  const getRes = await ghApi(`/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`);
  const sha = getRes.json.sha;
  const b64 = Buffer.from(newCode, 'utf8').toString('base64');
  const putRes = await ghApi(`/repos/${REPO}/contents/${FILE_PATH}`, 'PUT', {
    message: `geocode: fix ${fixed} scenic spot coordinates via Nominatim`,
    content: b64,
    branch: BRANCH,
    sha: sha
  });
  console.log('Upload result:', putRes.status);
}

main().catch(e => { console.error(e); process.exit(1); });
