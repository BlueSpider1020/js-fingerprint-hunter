// puppeteer-fp-dump-cookies.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const HEADLESS = false;
  const URL_FILTER = null; // keep as in previous script or change to filter network logging

  // ensure cookies dir exists
  const COOKIES_DIR = path.resolve(process.cwd(), 'cookies');
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Console capture from all frames
  page.on('console', async msg => {
    try {
      const args = msg.args();
      const out = [];
      for (const a of args) {
        try { out.push(await a.jsonValue()); } catch { out.push(a.toString()); }
      }
      const location = msg.location && msg.location().url ? msg.location().url : 'unknown';
      console.log(`[PAGE][${location}]`, ...out);
    } catch (e) {
      console.log('console capture error', e);
    }
  });

  // Capture Set-Cookie headers as before
  const capturedSetCookies = [];
  const parsedCookies = {};
  page.on('response', async response => {
    try {
      const url = response.url();
      const headers = response.headers();
      const scHeader = headers['set-cookie'] || headers['Set-Cookie'] || headers['set-cookie2'];
      if (scHeader) {
        let cookieStrings = scHeader.split(/\r?\n/).flatMap(s => s.split(/,(?=[^;]+=)/));
        cookieStrings = cookieStrings.map(s => s.trim()).filter(Boolean);
        cookieStrings.forEach(cookieStr => {
          capturedSetCookies.push({ url, cookieStr });
          console.log(`[SET-COOKIE] ${url}  ->  ${cookieStr}`);

          const parts = cookieStr.split(';').map(p => p.trim());
          const [nameVal, ...attrs] = parts;
          const eqIdx = nameVal.indexOf('=');
          if (eqIdx > -1) {
            const name = nameVal.slice(0, eqIdx).trim();
            const value = nameVal.slice(eqIdx + 1).trim();
            const attrObj = {};
            attrs.forEach(a => {
              const aEq = a.indexOf('=');
              if (aEq > -1) {
                const k = a.slice(0, aEq).trim();
                const v = a.slice(aEq + 1).trim();
                attrObj[k.toLowerCase()] = v;
              } else {
                attrObj[a.toLowerCase()] = true;
              }
            });

            if (!parsedCookies[name]) parsedCookies[name] = [];
            parsedCookies[name].push({ url, cookieString: cookieStr, value, attrs: attrObj });
          }
        });
      }
    } catch (e) {
      console.error('response handler error', e);
    }
  });

  // === Your injection payload (kept compact here) ===
  // Replace the body of hookScript with your full hooks if you want (canvas, audio, fetch/XHR etc.)
  const hookScript = (urlFilter) => `
    (function(){
      const prefix = 'FP-HOOK';
      function safeRun(fn){ try{ fn(); }catch(e){ try{ console.warn(prefix,'hook error',e&&e.message); }catch{} } }
      function hookProp(obj, prop, label) { safeRun(()=>{ const origVal = obj[prop]; try{ Object.defineProperty(obj, prop, { configurable: true, get(){ console.log(prefix, label + '.' + prop + ' read ->', origVal); return origVal; } }); } catch(e){} }); }
      function hookMethod(obj, name, label){ safeRun(()=>{ const orig = obj[name]; if(!orig || orig.__hooked) return; const wrapped = function(...a){ try{ console.log(prefix, label + '.' + name + ' called ->', a); }catch(e){} return orig.apply(this,a); }; wrapped.__hooked = true; obj[name] = wrapped; }); }
      function shouldLogUrl(u){ if(!${urlFilter ? 'true' : 'false'}) return true; try{ return ${urlFilter instanceof RegExp ? urlFilter.toString() + '.test(u)' : `String(u).includes(${JSON.stringify(urlFilter)})`}; }catch(e){ return true; } }

      safeRun(()=>{ ['innerWidth','innerHeight','outerWidth','outerHeight'].forEach(p=>hookProp(window,p,'window')); try{ const realScreen = window.screen; const proxy = new Proxy(realScreen, { get(t,p){ try{ if(typeof p==='string'){ console.log(prefix,'screen.'+p,'->',t[p]); } }catch(e){} return Reflect.get(t,p); } }); Object.defineProperty(window,'screen',{configurable:true,value:proxy}); }catch(e){} });

      safeRun(()=>{ ['platform','language','languages','hardwareConcurrency','deviceMemory','maxTouchPoints','vendor'].forEach(p=>hookProp(navigator,p,'navigator')); });

      // fetch wrapper (reads request & response bodies when possible)
      safeRun(()=>{ try{ const ofetch = window.fetch.bind(window); window.fetch = async function(input, init){ try{ const req = input instanceof Request ? (init? new Request(input, init): input) : new Request(input, init); const method = req.method; const url = req.url; let reqBody = undefined; if(method !== 'GET' && method !== 'HEAD'){ try{ reqBody = await req.clone().text(); }catch(e){ reqBody = '[unreadable]'; } } if(shouldLogUrl(url)) console.log(prefix+'-FETCH','req', {url, method, body:reqBody}); const resp = await ofetch(req); if(shouldLogUrl(resp.url)){ try{ const txt = await resp.clone().text(); let parsed = txt; try{ parsed = JSON.parse(txt); }catch{} console.log(prefix+'-FETCH','resp',{url:resp.url,status:resp.status,body: (typeof parsed === 'string' ? parsed.slice(0,200) : parsed)}); }catch(e){ console.log(prefix+'-FETCH','resp unreadable',resp.url); } } return resp; }catch(e){ try{ console.warn(prefix+'-FETCH','error',e&&e.message);}catch{} return ofetch(input, init);} }; }catch(e){} });

      // XHR wrapper
      safeRun(()=>{ try{ const X = XMLHttpRequest.prototype; const oOpen = X.open; const oSend = X.send; X.open = function(m,u){ this.__m = m; this.__u = u; return oOpen.apply(this, arguments); }; X.send = function(b){ try{ if(shouldLogUrl(this.__u)) console.log(prefix+'-XHR','send',{url:this.__u,method:this.__m,body:b}); this.addEventListener('load', ()=>{ try{ if(shouldLogUrl(this.__u)){ let resp = (this.responseType === '' || this.responseType === 'text')? this.responseText : '[non-text]'; try{ const j = JSON.parse(resp); resp = j; }catch{} console.log(prefix+'-XHR','resp',{url:this.__u,status:this.status,response: (typeof resp === 'string' ? resp.slice(0,200) : resp)}); } }catch(e){} }); }catch(e){} return oSend.apply(this, arguments); }; }catch(e){} });

      // audio/dom insertion hooks (mutation observer, createElement, play)
      safeRun(()=>{ try{ const origCreate = Document.prototype.createElement; Document.prototype.createElement = function(tag){ const el = origCreate.apply(this, arguments); try{ if(String(tag).toLowerCase()==='audio') console.log(prefix+'-AUDIO','createElement audio',el); }catch(e){} return el; }; const mo = new MutationObserver(muts=>{ for(const m of muts){ if(m.addedNodes){ m.addedNodes.forEach(n=>{ try{ if(n.nodeType===1){ if(n.tagName && n.tagName.toLowerCase()==='audio'){ console.log(prefix+'-AUDIO','audio added',n, n.src || n.getAttribute && n.getAttribute('src')); } else { const aud = n.querySelector && n.querySelector('audio'); if(aud) console.log(prefix+'-AUDIO','audio inside added node',aud,aud.src || aud.getAttribute && aud.getAttribute('src')); } } }catch(e){} }); } } }); mo.observe(document,{childList:true,subtree:true}); try{ const proto = HTMLMediaElement && HTMLMediaElement.prototype; if(proto && proto.play){ const origPlay = proto.play; proto.play = function(){ try{ const s = this.currentSrc || this.src || (this.getAttribute && this.getAttribute('src')); console.log(prefix+'-AUDIO','play',s); }catch(e){} return origPlay.apply(this, arguments); }; } }catch(e){} }catch(e){} });

      console.log(prefix,'injection-complete for frame',location.href);
    })();
  `;

  // Helper: inject script into given frame (use CDP-level evaluateOnNewDocument for robustness)
  async function injectIntoFrame(frame) {
    try {
      // frames may be cross-origin; evaluateOnNewDocument at frame scope isn't available on Frame directly,
      // but Puppeteer's Frame has evaluateOnNewDocument in newer versions — fallback to frame.evaluate if needed.
      if (typeof frame.evaluateOnNewDocument === 'function') {
        await frame.evaluateOnNewDocument(hookScript(URL_FILTER));
      } else {
        // fallback: run the script immediately (won't run *before* frame scripts but still useful)
        await frame.evaluate(hookScript(URL_FILTER));
      }
    } catch (err) {
      // cross-origin frame may throw — ignore, we'll still collect cookies via network layer
      // but try to send the script via CDP as a last resort:
      try {
        const client = await frame._client(); // internal API; might not always work
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: hookScript(URL_FILTER) });
      } catch (e) {
        // ignore
      }
    }
  }

  // Inject into all current frames
  for (const frame of page.frames()) {
    await injectIntoFrame(frame);
  }

  // Re-inject on future frame events
  page.on('frameattached', async frame => {
    await injectIntoFrame(frame).catch(()=>{});
  });
  page.on('framenavigated', async frame => {
    await injectIntoFrame(frame).catch(()=>{});
  });

  // Navigate to target
  const target = 'https://www.eticketing.co.uk/tottenhamhotspur/Events';
  await page.goto(target, { waitUntil: 'load' });

  console.log('Page loaded — hooks injected (where possible).');

  // === NEW: collect & dump cookies per-frame/domain ===
  async function dumpCookiesPerDomain() {
    try {
      const frames = page.frames();
      const origins = new Map(); // origin -> array of frame urls
      for (const f of frames) {
        try {
          const fu = f.url();
          if (!fu || fu === 'about:blank') continue;
          let origin;
          try { origin = new URL(fu).origin; } catch (e) { origin = fu; }
          if (!origins.has(origin)) origins.set(origin, new Set());
          origins.get(origin).add(fu);
        } catch (e) {}
      }

      for (const [origin, urlSet] of origins.entries()) {
        const urls = Array.from(urlSet);
        // ask Puppeteer for cookies relevant to these URLs
        let cookies = [];
        try {
          // page.cookies accepts list of URLs
          cookies = await page.cookies(...urls);
        } catch (e) {
          try {
            // fallback: get all cookies and filter by domain
            const all = await page.cookies();
            cookies = all.filter(c => (c.domain && origin.includes(c.domain)) || (c.url && origin.includes(new URL(c.url).origin)));
          } catch (e2) {
            cookies = [];
          }
        }
        const host = (() => {
          try { return new URL(origin).hostname; } catch (e) { return origin.replace(/[^a-z0-9.-]/gi,'_'); }
        })();
        const outPath = path.join(COOKIES_DIR, `cookies_${host}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ origin, urls, cookies }, null, 2));
        console.log(`Wrote ${outPath} (${cookies.length} cookies)`);
      }
    } catch (e) {
      console.error('dumpCookiesPerDomain error', e);
    }
  }

  // Dump cookies now, and also every 10s for the session (helps capture later-set cookies)
  await dumpCookiesPerDomain();
  const interval = setInterval(dumpCookiesPerDomain, 10000);

  // Keep process running so you can inspect; stop after 2 minutes (adjust as needed)
  await new Promise(res => setTimeout(res, 2 * 60 * 1000));
  clearInterval(interval);

  // final dump on exit
  await dumpCookiesPerDomain();

  console.log('Finished. Closing browser.');
  await browser.close();
})();
