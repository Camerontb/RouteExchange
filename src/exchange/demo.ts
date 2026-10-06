// Two minimal demo clients the hub serves, so the QR → route → chat loop can be
// shown with just the middleware running. The real bridge is FECDIS and the real
// pilot is EMPX's PPU; these stand in for them while those are wired up.

const STYLE = /* css */ `
  :root { color-scheme: dark; --bg:#071219; --panel:#0d1c25; --line:#203a47; --fg:#d8e7ef; --muted:#7e97a4; --accent:#22d3ee; --ok:#34d399; --warn:#f59e0b; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:20px 18px 40px; }
  h1 { font-size:18px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin:0 0 2px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .code { font:700 40px/1 ui-monospace,monospace; letter-spacing:.22em; text-align:center; margin:6px 0 14px; }
  #qr { display:flex; justify-content:center; padding:10px; background:#fff; border-radius:10px; width:fit-content; margin:0 auto; }
  .peer { display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); } .dot.on { background:var(--ok); }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 4px; }
  input,textarea { width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:9px 10px; font:inherit; }
  textarea { resize:vertical; min-height:60px; }
  button { background:var(--accent); color:#002028; border:0; border-radius:8px; padding:10px 14px; font:600 14px/1 inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button:disabled { opacity:.4; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; } .row > * { min-width:0; }
  .log { display:flex; flex-direction:column; gap:7px; max-height:240px; overflow-y:auto; margin-top:6px; }
  .msg { max-width:85%; padding:6px 10px; border:1px solid var(--line); border-radius:9px; background:var(--bg); font-size:14px; }
  .msg.me { align-self:flex-end; background:#06303a; border-color:#0b4a58; } .msg .who { font-size:10px; color:var(--muted); display:block; }
  .status { font-size:14px; font-weight:600; } .status small { font-weight:400; color:var(--muted); }
  .offer { border:1px solid var(--accent); border-radius:10px; padding:12px; margin-top:8px; }
  .muted { color:var(--muted); font-size:13px; }
  h2 { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:2px 0 8px; }
`;

const wsBase = /* js */ `function wsUrl(q){return (location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'+q;}`;

export const PILOT_HTML = /* html */ `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPU — Route Exchange demo</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>${STYLE}</style></head><body><div class="wrap">
  <h1>PPU · pilot</h1>
  <p class="sub">Pair with the ship, then receive the route and chat.</p>

  <div class="card">
    <h2>Pairing</h2>
    <div class="code" id="code">······</div>
    <div id="qr"></div>
    <p class="muted" style="text-align:center;margin:12px 0 0">Scan to open the bridge, or type this code there.</p>
    <p class="peer" style="margin-top:10px"><span class="dot" id="peerDot"></span><span id="peerTxt">waiting for the ship…</span></p>
  </div>

  <div class="card">
    <h2>Incoming route</h2>
    <div id="offerBox"><p class="muted">No route yet.</p></div>
  </div>

  <div class="card">
    <h2>Chat</h2>
    <div class="log" id="log"></div>
    <form class="row" id="chatForm" style="margin-top:10px">
      <input id="chatInput" placeholder="Message the bridge…" autocomplete="off">
      <button>Send</button>
    </form>
  </div>
</div>
<script>
${wsBase}
let ws, offerId=null;
const $=id=>document.getElementById(id);
function connect(){
  ws=new WebSocket(wsUrl('?role=pilot'));
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.type==='hello'){ $('code').textContent=m.code;
      const url=location.origin+'/demo/bridge?code='+m.code;
      $('qr').innerHTML=''; new QRCode($('qr'),{text:url,width:180,height:180});
      setPeer(m.peerConnected); }
    else if(m.type==='peer'){ setPeer(m.connected); }
    else if(m.type==='route'){ showOffer(m); }
    else if(m.type==='chat'){ addMsg(m.from,m.text,false); }
  };
  ws.onclose=()=>setTimeout(connect,1500);
}
function setPeer(on){ $('peerDot').className='dot'+(on?' on':''); $('peerTxt').textContent=on?'Ship ECDIS connected':'waiting for the ship…'; }
function showOffer(m){ offerId=m.id;
  const wpts=(m.waypoints&&m.waypoints.length)||0;
  const from=(m.from&&(m.from.shipName||m.from.system))||'ship';
  $('offerBox').innerHTML='<div class="offer"><b>'+esc(m.name||'Route')+'</b><div class="muted">from '+esc(from)+' · '+wpts+' waypoints</div>'
    +'<div class="row" style="margin-top:10px"><button id="acc">Accept</button><button class="ghost" id="rej">Request changes</button></div></div>';
  ws.send(JSON.stringify({type:'status',id:offerId,state:'viewed'}));
  $('acc').onclick=()=>{ws.send(JSON.stringify({type:'status',id:offerId,state:'accepted'})); done('Accepted — running this route');};
  $('rej').onclick=()=>{const n=prompt('What should change?')||''; ws.send(JSON.stringify({type:'status',id:offerId,state:'rejected',note:n})); done('Changes requested');};
}
function done(t){ $('offerBox').innerHTML='<p class="status">'+esc(t)+'</p>'; }
function addMsg(who,text,me){ const d=document.createElement('div'); d.className='msg'+(me?' me':''); d.innerHTML='<span class="who">'+esc(who)+'</span>'+esc(text); $('log').appendChild(d); $('log').scrollTop=9e9; }
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
$('chatForm').onsubmit=e=>{e.preventDefault(); const t=$('chatInput').value.trim(); if(!t)return; ws.send(JSON.stringify({type:'chat',text:t})); addMsg('PPU',t,true); $('chatInput').value='';};
connect();
</script></body></html>`;

export const BRIDGE_HTML = /* html */ `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bridge — Route Exchange demo</title>
<style>${STYLE}</style></head><body><div class="wrap">
  <h1>Ship ECDIS · bridge</h1>
  <p class="sub">Stand-in for FECDIS. Pair with the PPU, send a route, chat.</p>

  <div class="card" id="pairCard">
    <h2>Pair with the PPU</h2>
    <label for="codeIn">6-digit code from the PPU (or scan its QR)</label>
    <div class="row"><input id="codeIn" inputmode="numeric" maxlength="6" placeholder="482913"><button id="joinBtn">Connect</button></div>
    <p class="peer" style="margin-top:10px"><span class="dot" id="peerDot"></span><span id="peerTxt">not paired</span></p>
  </div>

  <div class="card">
    <h2>Send route</h2>
    <label for="rname">Route name</label>
    <input id="rname" value="Helsinki inbound">
    <p class="muted" style="margin:8px 0 0">Demo route: 4 waypoints in the Helsinki approaches.</p>
    <div class="row" style="margin-top:10px"><button id="sendBtn" disabled>Send route → PPU</button></div>
    <p class="status" id="status" style="margin-top:10px"></p>
  </div>

  <div class="card">
    <h2>Chat</h2>
    <div class="log" id="log"></div>
    <form class="row" id="chatForm" style="margin-top:10px">
      <input id="chatInput" placeholder="Message the pilot…" autocomplete="off">
      <button id="chatSend" disabled>Send</button>
    </form>
  </div>
</div>
<script>
${wsBase}
const $=id=>document.getElementById(id);
const SAMPLE=[{lat:59.95,lng:24.80,name:'WP1'},{lat:60.05,lng:24.90,name:'WP2'},{lat:60.12,lng:24.96,name:'WP3'},{lat:60.157,lng:24.95,name:'South Harbour'}];
const STATES={sending:'Sending…',delivered:'Delivered to PPU',viewed:'Pilot viewing…',accepted:'Accepted — PPU running the route',rejected:'Pilot requested changes'};
let ws,code='';
const params=new URLSearchParams(location.search); if(params.get('code')) $('codeIn').value=params.get('code').replace(/\\D/g,'').slice(0,6);
function connect(){
  code=$('codeIn').value.replace(/\\D/g,'').slice(0,6); if(code.length!==6){setStatus('Enter the 6-digit code');return;}
  ws=new WebSocket(wsUrl('?role=bridge&code='+code));
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.type==='hello'){ setPeer(m.peerConnected,'Paired · code '+m.code); enable(true); }
    else if(m.type==='peer'){ setPeer(m.connected); }
    else if(m.type==='status'){ setStatus(STATES[m.state]||m.state, m.note); }
    else if(m.type==='chat'){ addMsg(m.from,m.text,false); }
    else if(m.type==='error'){ setStatus('Pairing failed: '+m.error); enable(false); }
  };
  ws.onclose=()=>{ enable(false); };
}
function enable(on){ $('sendBtn').disabled=!on; $('chatSend').disabled=!on; }
function setPeer(on,txt){ $('peerDot').className='dot'+(on?' on':''); if(txt)$('peerTxt').textContent=txt; else $('peerTxt').textContent=on?'PPU connected':'PPU not connected'; }
function setStatus(t,note){ $('status').innerHTML=esc(t)+(note?' <small>· '+esc(note)+'</small>':''); }
function addMsg(who,text,me){ const d=document.createElement('div'); d.className='msg'+(me?' me':''); d.innerHTML='<span class="who">'+esc(who)+'</span>'+esc(text); $('log').appendChild(d); $('log').scrollTop=9e9; }
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
$('joinBtn').onclick=connect;
$('sendBtn').onclick=()=>{ setStatus(STATES.sending);
  ws.send(JSON.stringify({type:'route',to:{pairing:code},from:{shipName:'PACIFIC DAWN',mmsi:503000001,system:'DEMO BRIDGE'},name:$('rname').value||'Route',sentAt:new Date().toISOString(),waypoints:SAMPLE}));
};
$('chatForm').onsubmit=e=>{e.preventDefault(); const t=$('chatInput').value.trim(); if(!t||!ws)return; ws.send(JSON.stringify({type:'chat',text:t})); addMsg('Bridge',t,true); $('chatInput').value='';};
if(params.get('code')) connect();
</script></body></html>`;
