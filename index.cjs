// index.cjs
// Build a ~2h YouTube playlist of popular songs from 1990–1993.
// CommonJS (no ESM-only deps). OAuth via loopback redirect.

require('dotenv').config();

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const PLAYLIST_TITLE = "Early 90s Hits (1990–1993) ~2h";
const PLAYLIST_DESCRIPTION = "Auto-compiled playlist of popular songs from 1990–1993.";
const TARGET_MINUTES = 120;   // aim for 2h
const MAX_OVERRUN_MIN = 5;    // small overage tolerance

// Your region/language (tweak if you want)
const REGION_CODE = 'CA';     // e.g., 'US', 'CA', etc.
const RELEVANCE_LANG = 'en';

// Seed list — edit as you like. Format: "Artist - Title"
const SONGS = [
  "Madonna - Vogue",
  "Vanilla Ice - Ice Ice Baby",
  "Deee-Lite - Groove Is in the Heart",
  "Roxette - It Must Have Been Love",
  "MC Hammer - U Can't Touch This",
  "George Michael - Freedom! '90",
  "Nirvana - Smells Like Teen Spirit",
  "R.E.M. - Losing My Religion",
  "Michael Jackson - Black or White",
  "Paula Abdul - Rush Rush",
  "Seal - Crazy",
  "Right Said Fred - I'm Too Sexy",
  "Boyz II Men - End of the Road",
  "Whitney Houston - I Will Always Love You",
  "Kris Kross - Jump",
  "Guns N' Roses - November Rain",
  "Radiohead - Creep",
  "U2 - One",
  "Ace of Base - All That She Wants",
  "4 Non Blondes - What's Up",
  "Snow - Informer",
  "Snap! - Rhythm Is a Dancer",
  "Haddaway - What Is Love",
  "House of Pain - Jump Around",
  "Robin S. - Show Me Love",
  "En Vogue - My Lovin' (You're Never Gonna Get It)",
  "PM Dawn - Set Adrift on Memory Bliss",
  "Mariah Carey - Dreamlover",
  "Counting Crows - Mr. Jones"
];

// ---- OAuth/token setup ----
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:5173/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// helpers
function parseISODuration(iso) {
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

function openInBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

async function saveToken(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  console.log(`Saved OAuth tokens to ${TOKEN_PATH}`);
}

function haveSavedToken() {
  return fs.existsSync(TOKEN_PATH);
}

function loadSavedToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch { return null; }
}

function authUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube'],
    prompt: 'consent',
  });
}

async function ensureAuth() {
  if (haveSavedToken()) {
    const saved = loadSavedToken();
    if (saved) { oauth2Client.setCredentials(saved); return; }
  }
  const url = authUrl();
  console.log('\nAuthorize this app by visiting:\n', url, '\n');
  openInBrowser(url);

  await new Promise((resolve, reject) => {
    const expectedPath = new URL(REDIRECT_URI).pathname;
    const expectedPort = Number(new URL(REDIRECT_URI).port) || 5173;
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, REDIRECT_URI);
        if (reqUrl.pathname !== expectedPath) {
          res.writeHead(404); res.end('Not found'); return;
        }
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        if (error) {
          console.error('OAuth error:', error);
          res.writeHead(400); res.end('OAuth error: ' + error);
          server.close(); reject(new Error(error)); return;
        }
        if (!code) {
          res.writeHead(400); res.end('Missing code'); return;
        }
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        await saveToken(tokens);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authentication complete. You can close this window.');
        server.close(); resolve();
      } catch (e) {
        console.error('OAuth exchange failed:', e?.message || e);
        res.writeHead(500); res.end('OAuth exchange failed');
        server.close(); reject(e);
      }
    });
    server.listen(expectedPort, '127.0.0.1', () => {
      console.log(`Waiting for OAuth callback at ${REDIRECT_URI} ...`);
    });
  });
}

// ---------- YouTube helpers ----------

// Try multiple query styles; return the best videoId we find.
async function searchTopMusicVideoId(artistTitle) {
  // Make 3 query variants to improve hit rate
  const variants = [
    artistTitle + ' official video',
    `"${artistTitle}"`,
    artistTitle + ' audio'
  ];

  for (const q of variants) {
    const res = await youtube.search.list({
      part: ['id', 'snippet'],
      q,
      type: 'video',
      maxResults: 8,
      order: 'relevance',
      regionCode: REGION_CODE,
      relevanceLanguage: RELEVANCE_LANG,
      safeSearch: 'none',
      // NOTE: No publishedAfter/Before filters; many official uploads are much later than 1993.
    });

    const items = res.data.items || [];
    if (!items.length) continue;

    // Pull durations to help choose a sensible result (2–8 minutes typical)
    const ids = items.map(x => x.id.videoId).filter(Boolean);
    const durMap = await getVideoDurations(ids);

    // Rank: prefer durations ~ 120–480 sec; then by YouTube "relevance" order
    const ranked = items
      .map((it, idx) => {
        const id = it.id.videoId;
        const dur = durMap[id] || 0;
        const score =
          (dur >= 120 && dur <= 480 ? 1000 : 0) // big bonus for 2–8 min
          - Math.abs(240 - dur) / 10             // closer to 4 min gets small boost
          - idx;                                  // earlier search results slightly better
        return { id, dur, score, title: it.snippet?.title || '' };
      })
      .sort((a, b) => b.score - a.score);

    if (ranked.length) {
      const chosen = ranked[0];
      // Optional: log the pick
      console.log(`  ✓ Using: ${chosen.id} (${Math.round(chosen.dur/60)}m) — ${items.find(i=>i.id.videoId===chosen.id)?.snippet?.title || ''}`);
      return chosen.id;
    }
  }
  return null;
}

async function getVideoDurations(videoIds) {
  if (!videoIds.length) return {};
  const res = await youtube.videos.list({
    part: ['contentDetails'],
    id: videoIds,
    maxResults: 50,
  });
  const map = {};
  (res.data.items || []).forEach(v => {
    map[v.id] = parseISODuration(v.contentDetails?.duration || 'PT0S');
  });
  return map;
}

async function createPlaylist(title, description) {
  const res = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: 'private' }, // change to "public" or "unlisted" if you want
    },
  });
  return res.data.id;
}

async function addToPlaylist(playlistId, videoId) {
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId },
      },
    },
  });
}

// -------------- main --------------
async function main() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
    process.exit(1);
  }

  await ensureAuth();

  console.log('Creating playlist…');
  const playlistId = await createPlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION);
  console.log('Playlist ID:', playlistId);

  const videoIds = [];
  for (const s of SONGS) {
    try {
      console.log('Searching:', s);
      const vid = await searchTopMusicVideoId(s);
      if (vid) {
        videoIds.push(vid);
      } else {
        console.log('  ✗ No result for:', s);
      }
    } catch (e) {
      console.warn('Search error for', s, e?.message || e);
    }
  }

  // Get durations and add until ~2h
  const durations = await getVideoDurations(videoIds);
  let total = 0; // seconds
  for (const vid of videoIds) {
    const dur = durations[vid] || 0;
    if ((total + dur) / 60 > TARGET_MINUTES + MAX_OVERRUN_MIN) break;
    try {
      await addToPlaylist(playlistId, vid);
      total += dur;
      console.log(`Added ${vid} (${Math.round(dur/60)} min). Total: ${Math.round(total/60)} min`);
      if (total / 60 >= TARGET_MINUTES) break;
    } catch (e) {
      console.warn('Add error for', vid, e?.message || e);
    }
  }

  console.log(`\nDone. Total length ≈ ${Math.round(total/60)} minutes.`);
  console.log(`Open your playlist: https://www.youtube.com/playlist?list=${playlistId}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});