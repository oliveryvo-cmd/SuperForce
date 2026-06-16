const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

const MIME = {
  '.html':'text/html','.js':'application/javascript',
  '.css':'text/css','.png':'image/png','.ico':'image/x-icon',
  '.json':'application/json','.webmanifest':'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const players = new Map();
let nextId = 1;
let activeBoss = null;

const BOSS_DEFS = [
  { name:'TITAN OVERLORD', type:'strength', icon:'👹', color:'#ef4444', hp:2000, maxHp:2000, attack:180, defense:120, speed:80, rarity:5,
    moves:[{name:'DEVASTATE',power:120,accuracy:90,type:'strength'},{name:'CRUSH',power:100,accuracy:100,type:'strength'},{name:'RAMPAGE',power:140,accuracy:80,type:'strength'}]},
  { name:'STORM EMPEROR', type:'energy', icon:'⚡', color:'#facc15', hp:1800, maxHp:1800, attack:200, defense:100, speed:120, rarity:5,
    moves:[{name:'THUNDER CRASH',power:130,accuracy:90,type:'energy'},{name:'VOLT SURGE',power:110,accuracy:100,type:'energy'},{name:'LIGHTNING STORM',power:150,accuracy:80,type:'energy'}]},
  { name:'FROST COLOSSUS', type:'water', icon:'❄️', color:'#93c5fd', hp:2200, maxHp:2200, attack:160, defense:160, speed:60, rarity:5,
    moves:[{name:'ICE AGE',power:120,accuracy:90,type:'water'},{name:'FREEZE BLAST',power:140,accuracy:85,type:'water'},{name:'BLIZZARD',power:160,accuracy:75,type:'water'}]},
];

function spawnBoss() {
  const def = BOSS_DEFS[Math.floor(Math.random() * BOSS_DEFS.length)];
  const angle = Math.random() * Math.PI * 2;
  const dist  = 30 + Math.random() * 50;
  activeBoss = { ...def, hp: def.maxHp, x: Math.cos(angle)*dist, z: Math.sin(angle)*dist, raid: null };
  broadcast({ type: 'bossSpawn', boss: activeBoss });
  console.log('Boss spawned:', activeBoss.name);
  setTimeout(() => { if (activeBoss) { activeBoss = null; broadcast({ type: 'bossDespawn' }); setTimeout(spawnBoss, 3*60*1000); } }, 10*60*1000);
}
setTimeout(spawnBoss, 60*1000);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendTo(id, obj) { const p = players.get(id); if (p) send(p.ws, obj); }
function broadcast(obj, exceptId) {
  const str = JSON.stringify(obj);
  players.forEach((p, id) => { if (id !== exceptId && p.ws.readyState === 1) p.ws.send(str); });
}

wss.on('connection', ws => {
  const id = 'p' + (nextId++);
  const player = { ws, id, name:'Trainer', x:0, z:0, yaw:0, team:[], mmr:1000, level:1, base:null };
  players.set(id, player);

  send(ws, { type:'welcome', id });
  players.forEach((p, pid) => {
    if (pid === id) return;
    send(ws, { type:'playerJoin', id:pid, name:p.name, x:p.x, z:p.z, yaw:p.yaw, level:p.level, mmr:p.mmr });
    if (p.base) send(ws, { type:'base', id:pid, playerName:p.name, ...p.base });
  });
  if (activeBoss) send(ws, { type:'bossSpawn', boss:activeBoss });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'join':
        player.name = (msg.name||'Trainer').slice(0,20);
        player.team = msg.team||[]; player.mmr = msg.mmr||1000; player.level = msg.level||1;
        broadcast({ type:'playerJoin', id, name:player.name, x:player.x, z:player.z, yaw:player.yaw, level:player.level, mmr:player.mmr }, id);
        break;
      case 'move':
        player.x = msg.x||0; player.z = msg.z||0; player.yaw = msg.yaw||0;
        broadcast({ type:'playerMove', id, x:player.x, z:player.z, yaw:player.yaw }, id);
        break;
      case 'chat':
        broadcast({ type:'chat', id, name:player.name, text:(msg.text||'').slice(0,200) });
        break;
      case 'challenge': {
        const t = players.get(msg.targetId);
        if (t) send(t.ws, { type:'challenged', fromId:id, name:player.name, format:msg.format||'1v1' });
        break;
      }
      case 'challengeResponse': {
        const ch = players.get(msg.fromId);
        if (!ch) break;
        if (msg.accepted) {
          const battleId = 'b'+Date.now();
          const p1team = ch.team.filter(s=>s.hp>0).slice(0,3);
          const p2team = player.team.filter(s=>s.hp>0).slice(0,3);
          if (!p1team.length||!p2team.length) break;
          const turn = Math.random()<0.5 ? ch.id : id;
          const bm = { type:'battleStart', battleId, format:'1v1', p1:{id:ch.id,name:ch.name,team:p1team}, p2:{id,name:player.name,team:p2team}, turn };
          send(ch.ws, bm); send(ws, bm);
        } else {
          send(ch.ws, { type:'challengeDeclined', byName:player.name });
        }
        break;
      }
      case 'battleMove': {
        const o = players.get(msg.oppId);
        if (o) send(o.ws, { type:'battleMove', battleId:msg.battleId, moveIdx:msg.moveIdx, fromId:id });
        break;
      }
      case 'battleEnd': {
        const o = players.get(msg.oppId);
        const endMsg = { type:'battleEnd', battleId:msg.battleId, winnerId:msg.winnerId, p1:msg.p1, p2:msg.p2, p1Team:msg.p1Team, p2Team:msg.p2Team, log:msg.log };
        if (o) send(o.ws, endMsg);
        send(ws, endMsg);
        if (msg.winnerId) {
          const w = players.get(msg.winnerId);
          const l = players.get(msg.winnerId === id ? msg.oppId : id);
          if (w) w.mmr = (w.mmr||1000)+25;
          if (l) l.mmr = Math.max(0,(l.mmr||1000)-20);
        }
        break;
      }
      case 'base':
        player.base = { name:msg.name, x:msg.x, z:msg.z, color:msg.color, icon:msg.icon };
        broadcast({ type:'base', id, playerName:player.name, ...player.base }, id);
        break;
      case 'joinBossRaid': {
        if (!activeBoss) { send(ws, { type:'raidError', reason:'No active boss' }); break; }
        if (!activeBoss.raid) activeBoss.raid = { members:[], phase:'lobby', host:id };
        const raid = activeBoss.raid;
        if (raid.members.find(m=>m.id===id)||raid.phase!=='lobby') break;
        raid.members.push({ id, name:player.name, super:player.team[0], hp:player.team[0]?.hp||100, alive:true, moveIdx:null });
        raid.members.forEach(m=>sendTo(m.id, { type:'raidLobby', members:raid.members, hostId:raid.host, bossName:activeBoss.name, bossIcon:activeBoss.icon }));
        break;
      }
      case 'startBossRaid': {
        if (!activeBoss?.raid||activeBoss.raid.host!==id||activeBoss.raid.phase!=='lobby') break;
        activeBoss.raid.phase='battle';
        activeBoss.hp=activeBoss.maxHp*activeBoss.raid.members.length*0.4;
        activeBoss.maxHp=activeBoss.hp;
        activeBoss.raid.members.forEach(m=>sendTo(m.id,{type:'raidBattleStart',boss:activeBoss,members:activeBoss.raid.members}));
        setTimeout(()=>raidStartTurn(activeBoss),500);
        break;
      }
      case 'raidMove': {
        if (!activeBoss?.raid) break;
        const m = activeBoss.raid.members.find(m=>m.id===id);
        if (m) m.moveIdx=msg.moveIdx;
        if (activeBoss.raid.members.every(m=>!m.alive||m.moveIdx!==null)) { clearTimeout(activeBoss.raid.turnTimer); raidProcessTurn(activeBoss); }
        break;
      }
      case 'tradeRequest': {
        const t = players.get(msg.targetId);
        if (t) { player._tradeOfferIdx=msg.offerIdx; send(t.ws,{type:'tradeRequest',fromId:id,fromName:player.name,offerName:msg.offerName,offerIcon:msg.offerIcon}); }
        break;
      }
      case 'tradeAccept': {
        const t = players.get(msg.targetId);
        if (!t) break;
        const mine=player.team[msg.myIdx], theirs=t.team[t._tradeOfferIdx||0];
        if (!mine||!theirs) break;
        player.team[msg.myIdx]=theirs; t.team[t._tradeOfferIdx||0]=mine;
        send(ws,{type:'tradeComplete',myIdx:msg.myIdx,theirSuper:theirs});
        send(t.ws,{type:'tradeComplete',myIdx:t._tradeOfferIdx||0,theirSuper:mine});
        break;
      }
      case 'tradeDecline': {
        const t = players.get(msg.targetId);
        if (t) send(t.ws,{type:'tradeDeclined'});
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type:'playerLeave', id });
    if (activeBoss?.raid) activeBoss.raid.members = activeBoss.raid.members.filter(m=>m.id!==id);
  });
});

function raidStartTurn(boss) {
  if (!boss.raid) return;
  boss.raid.members.forEach(m=>{ if(m.alive) m.moveIdx=null; });
  boss.raid.members.forEach(m=>sendTo(m.id,{type:'raidTurnStart',members:boss.raid.members,bossHp:boss.hp,bossMaxHp:boss.maxHp}));
  boss.raid.turnTimer = setTimeout(()=>raidProcessTurn(boss), 20000);
}

function raidProcessTurn(boss) {
  if (!boss.raid) return;
  clearTimeout(boss.raid.turnTimer);
  let log=[];
  boss.raid.members.forEach(m=>{ if(!m.alive) return; const d=Math.max(10,Math.round(50+Math.random()*80)); boss.hp=Math.max(0,boss.hp-d); log.push(`${m.name} dealt ${d} dmg!`); });
  const alive=boss.raid.members.filter(m=>m.alive);
  if (alive.length) {
    const t=alive[Math.floor(Math.random()*alive.length)];
    const d=Math.max(20,Math.round(80+Math.random()*100));
    t.hp=Math.max(0,t.hp-d);
    if(t.hp<=0){t.alive=false;log.push(`${t.name} fainted!`);}
    else log.push(`Boss hit ${t.name} for ${d}!`);
  }
  boss.raid.members.forEach(m=>sendTo(m.id,{type:'raidTurnResult',members:boss.raid.members,bossHp:boss.hp,bossMaxHp:boss.maxHp,log}));
  if (boss.hp<=0) {
    boss.raid.members.forEach(m=>sendTo(m.id,{type:'raidEnd',won:true,bossReward:{xp:500,coins:1000},bossDied:true}));
    activeBoss=null; broadcast({type:'bossDespawn'}); setTimeout(spawnBoss,3*60*1000);
  } else if (boss.raid.members.every(m=>!m.alive)) {
    boss.raid.members.forEach(m=>sendTo(m.id,{type:'raidEnd',won:false}));
    boss.raid=null;
  } else {
    setTimeout(()=>raidStartTurn(boss),1500);
  }
}

server.listen(PORT, () => console.log(`SuperForce → http://localhost:${PORT}`));
