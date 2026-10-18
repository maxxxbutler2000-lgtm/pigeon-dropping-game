import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
const scrypt=promisify(scryptCallback), hash=s=>createHash('sha256').update(s).digest('hex');
const page=readFileSync(new URL('./index.html',import.meta.url));
const limits={aim:5,value:15,crowd:8,speed:10,size:6,multi:2,splash:4,wings:6,gold:6,tips:8,bread:8,slow:4,dive:6,forecast:1,wind:5,combo:5,pierce:4,bounce:4,bounty:5,lucky:4,rainbow:1,birdbow:1,hats:1,drinks:1,balloons:1,confetti:1,crown:1,googly:1,bubbles:1,disco:1};
const n=(x,max=1e12)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>max)throw Object.assign(new Error('Invalid game save'),{status:400});return x};
export function cleanState(s){if(!s||typeof s!=='object')throw Object.assign(new Error('Invalid game save'),{status:400});return{coins:n(s.coins),score:Math.floor(n(s.score)),best:Math.floor(n(s.best??s.score)),totalHits:Math.floor(n(s.totalHits)),world:Math.floor(n(s.world,3)),worldHits:Math.floor(n(s.worldHits)),worldTime:n(s.worldTime,1e9),round:Math.max(1,Math.floor(n(s.round,10000))),levels:Object.fromEntries(Object.entries(limits).map(([k,max])=>[k,Math.floor(n(s.levels?.[k]??0,max))])),introduced:[...new Set([0,...(Array.isArray(s.introduced)?s.introduced:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<7)])]}}
export async function initDB(db){await db.query(`CREATE SCHEMA IF NOT EXISTS pigeon_patrol;CREATE TABLE IF NOT EXISTS pigeon_patrol.players(id SERIAL PRIMARY KEY,username VARCHAR(20) NOT NULL UNIQUE,password_hash TEXT NOT NULL,save JSONB,revision INTEGER NOT NULL DEFAULT 0,best_score BIGINT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE TABLE IF NOT EXISTS pigeon_patrol.sessions(token_hash TEXT PRIMARY KEY,player_id INTEGER NOT NULL REFERENCES pigeon_patrol.players(id) ON DELETE CASCADE,expires_at TIMESTAMPTZ NOT NULL);CREATE INDEX IF NOT EXISTS leaderboard_scores ON pigeon_patrol.players(best_score DESC);CREATE INDEX IF NOT EXISTS sessions_expiry ON pigeon_patrol.sessions(expires_at)`)}
// Optional one-time transfer when switching from the original dedicated database.
export async function migrateOriginal(target,source){
 await target.query('CREATE TABLE IF NOT EXISTS pigeon_patrol.migrations(name TEXT PRIMARY KEY,completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
 if((await target.query('SELECT name FROM pigeon_patrol.migrations WHERE name=$1',['original-database-v1'])).rows.length)return;
 const exists=await source.query("SELECT to_regclass('public.players') AS players,to_regclass('public.sessions') AS sessions,to_regclass('pigeon_patrol.players') AS isolated");
 if(!exists.rows[0].players||!exists.rows[0].sessions)throw new Error('Original database is missing account tables');
 const hasIsolatedAccounts=exists.rows[0].isolated&&(await source.query('SELECT id FROM pigeon_patrol.players LIMIT 1')).rows.length>0;
 const sourceSchema=hasIsolatedAccounts?'pigeon_patrol':'public';
 const players=(await source.query(`SELECT id,username,password_hash,save,revision,best_score,created_at FROM ${sourceSchema}.players`)).rows;
 const sessions=(await source.query(`SELECT token_hash,player_id,expires_at FROM ${sourceSchema}.sessions WHERE expires_at>NOW()`)).rows;
 const client=await target.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(70391642)");
 if((await client.query('SELECT name FROM pigeon_patrol.migrations WHERE name=$1',['original-database-v1'])).rows.length){await client.query('COMMIT');return}
 if((await client.query('SELECT id FROM pigeon_patrol.players LIMIT 1')).rows.length)throw new Error('Destination already contains accounts; refusing to overwrite');
 for(const p of players)await client.query('INSERT INTO pigeon_patrol.players(id,username,password_hash,save,revision,best_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,p.username,p.password_hash,p.save===null?null:JSON.stringify(p.save),p.revision,p.best_score,p.created_at]);
 for(const s of sessions)await client.query('INSERT INTO pigeon_patrol.sessions(token_hash,player_id,expires_at) VALUES($1,$2,$3)',[s.token_hash,s.player_id,s.expires_at]);
 await client.query("SELECT setval(pg_get_serial_sequence('pigeon_patrol.players','id'),COALESCE((SELECT MAX(id) FROM pigeon_patrol.players),1),EXISTS(SELECT 1 FROM pigeon_patrol.players))");
 await client.query('INSERT INTO pigeon_patrol.migrations(name) VALUES($1)',['original-database-v1']);await client.query('COMMIT');console.log('Account migration complete:',players.length,'players');
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function migrateHTTPS(target,url,token){
 await target.query('CREATE TABLE IF NOT EXISTS pigeon_patrol.migrations(name TEXT PRIMARY KEY,completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
 if((await target.query('SELECT name FROM pigeon_patrol.migrations WHERE name=$1',['original-database-v1'])).rows.length)return;
 if(!url.startsWith('https://')||!token)throw new Error('Secure migration configuration required');
 const response=await fetch(new URL('/api/internal-transfer',url),{method:'POST',headers:{'Content-Type':'application/json','X-Pigeon-Transfer':token},body:'{}',signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw new Error('Original game transfer was not authorized');const data=await response.json();
 if(!Array.isArray(data.players)||!Array.isArray(data.sessions))throw new Error('Invalid transfer response');
 const mock={query:async(sql)=>sql.includes('to_regclass')?{rows:[{players:'players',sessions:'sessions',isolated:null}]}:sql.includes('FROM public.players')?{rows:data.players}:{rows:data.sessions}};
 await migrateOriginal(target,mock);
}
export function app(db,{secure=true}={}){
 const attempts=new Map();let hashing=0,transferFrozen=false;
 const cookie=(token,age)=>`pigeon_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
 const json=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value))};
 async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}}
 async function user(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pigeon_session='))?.slice(15);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const r=await db.query('SELECT p.id,p.username,p.save,p.revision,p.best_score FROM pigeon_patrol.sessions s JOIN pigeon_patrol.players p ON p.id=s.player_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[hash(token)]);return r.rows[0]||null}
 async function session(res,id){const token=randomBytes(32).toString('hex');await db.query("INSERT INTO pigeon_patrol.sessions(token_hash,player_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",[hash(token),id]);return cookie(token,2592000)}
 return async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health'){await db.query('SELECT 1');res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return}
 if(!path.startsWith('/api/')){if(path==='/favicon.ico'){res.writeHead(204);res.end();return}if((path==='/'||path==='/index.html')&&['GET','HEAD'].includes(req.method)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:page);return}return json(res,404,{error:'Not found'})}
 if(req.method!=='GET'){const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)return json(res,403,{error:'Request origin not allowed'});if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'Use JSON'})}
 if(transferFrozen&&['/api/save','/api/signup','/api/login'].includes(path))return json(res,503,{error:'Moving your save to the shared database. Please retry in a minute.'});
 if(path==='/api/internal-transfer'&&req.method==='POST'){
 const key=process.env.MIGRATION_TOKEN,provided=req.headers['x-pigeon-transfer'];
 if(!key||typeof provided!=='string'||!timingSafeEqual(Buffer.from(hash(key)),Buffer.from(hash(provided))))return json(res,404,{error:'Not found'});
 transferFrozen=true;
 const players=(await db.query('SELECT id,username,password_hash,save,revision,best_score,created_at FROM pigeon_patrol.players')).rows;
 const sessions=(await db.query('SELECT token_hash,player_id,expires_at FROM pigeon_patrol.sessions WHERE expires_at>NOW()')).rows;
 return json(res,200,{players,sessions})}
 if(path==='/api/signup'||path==='/api/login'){
 if(req.method!=='POST')return json(res,405,{error:'Use POST'});
 const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();let limit=attempts.get(ip);if(!limit||limit.until<Date.now()){limit={count:0,until:Date.now()+900000};attempts.set(ip,limit)}if(++limit.count>20||hashing>=4)return json(res,429,{error:'Too many attempts. Try again later.'});if(attempts.size>10000)for(const [key,v]of attempts)if(v.until<Date.now())attempts.delete(key);
 const b=await body(req),username=String(b.username||'').trim().toLowerCase(),password=b.password;if(!/^[a-z0-9_]{3,20}$/.test(username)||typeof password!=='string'||password.length<10||password.length>128)return json(res,400,{error:'Use a 3–20 character username (letters, numbers, underscores) and a 10–128 character password.'});
 let player;hashing++;try{if(path==='/api/signup'){const salt=randomBytes(16).toString('hex'),key=await scrypt(password,salt,64);const r=await db.query('INSERT INTO pigeon_patrol.players(username,password_hash) VALUES($1,$2) RETURNING id,username,revision,save',[username,salt+':'+key.toString('hex')]);player=r.rows[0]}else{const r=await db.query('SELECT * FROM pigeon_patrol.players WHERE username=$1',[username]);player=r.rows[0];const [salt,key]=(player?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64)).split(':');const candidate=await scrypt(password,salt,64);if(!timingSafeEqual(Buffer.from(key,'hex'),candidate)||!player)return json(res,401,{error:'Username or password is incorrect.'})}}finally{hashing--}
 return json(res,200,{user:{id:player.id,username:player.username},save:player.save,revision:player.revision},{'Set-Cookie':await session(res,player.id)})}
 if(path==='/api/me'&&req.method==='GET'){const p=await user(req);return json(res,200,p?{user:{id:p.id,username:p.username},save:p.save,revision:p.revision}:{user:null})}
 if(path==='/api/logout'&&req.method==='POST'){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pigeon_session='))?.slice(15);if(token)await db.query('DELETE FROM pigeon_patrol.sessions WHERE token_hash=$1',[hash(token)]);return json(res,200,{ok:true},{'Set-Cookie':cookie('',0)})}
 if(path==='/api/save'&&req.method==='PUT'){const p=await user(req);if(!p)return json(res,401,{error:'Please log in again.'});const b=await body(req),save=cleanState(b.save);if(!Number.isInteger(b.revision)||b.revision<0)return json(res,400,{error:'Invalid save version'});const r=await db.query('UPDATE pigeon_patrol.players SET save=$1,revision=revision+1,best_score=GREATEST(best_score,$2) WHERE id=$3 AND revision=$4 RETURNING revision',[JSON.stringify(save),Math.max(save.score,save.best),p.id,b.revision]);if(!r.rows.length)return json(res,409,{error:'Another tab saved newer progress. Reload to continue.'});return json(res,200,{revision:r.rows[0].revision})}
 if(path==='/api/leaderboard'&&req.method==='GET'){const r=await db.query('SELECT username,best_score FROM pigeon_patrol.players WHERE best_score>0 ORDER BY best_score DESC,username ASC LIMIT 50');return json(res,200,{players:r.rows.map((p,i)=>({rank:i+1,username:p.username,score:Number(p.best_score)}))})}
 return json(res,404,{error:'Not found'});
 }catch(e){if(e.code==='23505')return json(res,409,{error:'That username is already taken.'});if(e.status)return json(res,e.status,{error:e.message});console.error('Request failed:',e.code||e.name);return json(res,503,{error:'Service temporarily unavailable. Please try again.'})}}
}
export function proxy(upstream){const target=new URL(upstream);if(target.protocol!=='https:')throw new Error('HTTPS upstream required');return async(req,res)=>{try{if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){res.writeHead(403);res.end('Origin not allowed');return}let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>20000){res.writeHead(413);res.end();return}chunks.push(chunk)}let headers={'Content-Type':req.headers['content-type']||'application/json'};if(req.headers.cookie)headers.Cookie=req.headers.cookie;if(req.headers.origin)headers.Origin=target.origin;const r=await fetch(new URL(req.url,target),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),redirect:'manual',signal:AbortSignal.timeout(30000)});const out={};for(const name of ['content-type','cache-control','x-content-type-options','referrer-policy','x-frame-options'])if(r.headers.has(name))out[name]=r.headers.get(name);const cookies=r.headers.getSetCookie();if(cookies.length)out['Set-Cookie']=cookies;res.writeHead(r.status,out);res.end(Buffer.from(await r.arrayBuffer()))}catch{res.writeHead(502);res.end('Game is temporarily unavailable. Please retry.')}}}
if(process.env.NODE_ENV!=='test'){
 if(process.env.UPSTREAM_URL){createServer(proxy(process.env.UPSTREAM_URL)).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Pigeon Patrol URL forwarding ready'))}
 else{
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL must be configured');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:10000});db.on('error',e=>console.error('Database connection error:',e.code));await initDB(db);
 if(process.env.MIGRATION_DATABASE_URL){const source=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL,max:1,connectionTimeoutMillis:10000});try{await migrateOriginal(db,source)}finally{await source.end()}}
 if(process.env.MIGRATION_SOURCE_URL)await migrateHTTPS(db,process.env.MIGRATION_SOURCE_URL,process.env.MIGRATION_TOKEN);
 setInterval(()=>db.query('DELETE FROM pigeon_patrol.sessions WHERE expires_at<NOW()').catch(()=>{}),3600000).unref();
 createServer(app(db,{secure:process.env.NODE_ENV==='production'})).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Pigeon Patrol and database ready'));
 }
}
