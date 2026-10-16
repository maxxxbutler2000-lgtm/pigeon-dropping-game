import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
const scrypt=promisify(scryptCallback), hash=s=>createHash('sha256').update(s).digest('hex');
const page=readFileSync(new URL('./index.html',import.meta.url));
const limits={aim:5,value:15,crowd:8,speed:10,size:6,multi:2,splash:4,wings:6,gold:6,tips:8,bread:8,slow:4,dive:6,forecast:1,wind:5,combo:5,pierce:4,bounce:4,bounty:5,lucky:4};
const n=(x,max=1e12)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>max)throw Object.assign(new Error('Invalid game save'),{status:400});return x};
export function cleanState(s){if(!s||typeof s!=='object')throw Object.assign(new Error('Invalid game save'),{status:400});return{coins:n(s.coins),score:Math.floor(n(s.score)),best:Math.floor(n(s.best??s.score)),totalHits:Math.floor(n(s.totalHits)),world:Math.floor(n(s.world,3)),worldHits:Math.floor(n(s.worldHits)),worldTime:n(s.worldTime,1e9),round:Math.max(1,Math.floor(n(s.round,10000))),levels:Object.fromEntries(Object.entries(limits).map(([k,max])=>[k,Math.floor(n(s.levels?.[k]??0,max))])),introduced:[...new Set([0,...(Array.isArray(s.introduced)?s.introduced:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<7)])]}}
export async function initDB(db){await db.query(`CREATE TABLE IF NOT EXISTS players(id SERIAL PRIMARY KEY,username VARCHAR(20) NOT NULL UNIQUE,password_hash TEXT NOT NULL,save JSONB,revision INTEGER NOT NULL DEFAULT 0,best_score BIGINT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,expires_at TIMESTAMPTZ NOT NULL);CREATE INDEX IF NOT EXISTS leaderboard_scores ON players(best_score DESC);CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`)}
export function app(db,{secure=true}={}){
 const attempts=new Map();let hashing=0;
 const cookie=(token,age)=>`pigeon_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
 const json=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value))};
 async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}}
 async function user(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pigeon_session='))?.slice(15);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const r=await db.query('SELECT p.id,p.username,p.save,p.revision,p.best_score FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[hash(token)]);return r.rows[0]||null}
 async function session(res,id){const token=randomBytes(32).toString('hex');await db.query("INSERT INTO sessions(token_hash,player_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",[hash(token),id]);return cookie(token,2592000)}
 return async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health'){await db.query('SELECT 1');res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return}
 if(!path.startsWith('/api/')){if(path==='/favicon.ico'){res.writeHead(204);res.end();return}if((path==='/'||path==='/index.html')&&['GET','HEAD'].includes(req.method)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:page);return}return json(res,404,{error:'Not found'})}
 if(req.method!=='GET'){const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)return json(res,403,{error:'Request origin not allowed'});if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'Use JSON'})}
 if(path==='/api/signup'||path==='/api/login'){
 if(req.method!=='POST')return json(res,405,{error:'Use POST'});
 const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();let limit=attempts.get(ip);if(!limit||limit.until<Date.now()){limit={count:0,until:Date.now()+900000};attempts.set(ip,limit)}if(++limit.count>20||hashing>=4)return json(res,429,{error:'Too many attempts. Try again later.'});if(attempts.size>10000)for(const [key,v]of attempts)if(v.until<Date.now())attempts.delete(key);
 const b=await body(req),username=String(b.username||'').trim().toLowerCase(),password=b.password;if(!/^[a-z0-9_]{3,20}$/.test(username)||typeof password!=='string'||password.length<10||password.length>128)return json(res,400,{error:'Use a 3–20 character username (letters, numbers, underscores) and a 10–128 character password.'});
 let player;hashing++;try{if(path==='/api/signup'){const salt=randomBytes(16).toString('hex'),key=await scrypt(password,salt,64);const r=await db.query('INSERT INTO players(username,password_hash) VALUES($1,$2) RETURNING id,username,revision,save',[username,salt+':'+key.toString('hex')]);player=r.rows[0]}else{const r=await db.query('SELECT * FROM players WHERE username=$1',[username]);player=r.rows[0];const [salt,key]=(player?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64)).split(':');const candidate=await scrypt(password,salt,64);if(!timingSafeEqual(Buffer.from(key,'hex'),candidate)||!player)return json(res,401,{error:'Username or password is incorrect.'})}}finally{hashing--}
 return json(res,200,{user:{id:player.id,username:player.username},save:player.save,revision:player.revision},{'Set-Cookie':await session(res,player.id)})}
 if(path==='/api/me'&&req.method==='GET'){const p=await user(req);return json(res,200,p?{user:{id:p.id,username:p.username},save:p.save,revision:p.revision}:{user:null})}
 if(path==='/api/logout'&&req.method==='POST'){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pigeon_session='))?.slice(15);if(token)await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(token)]);return json(res,200,{ok:true},{'Set-Cookie':cookie('',0)})}
 if(path==='/api/save'&&req.method==='PUT'){const p=await user(req);if(!p)return json(res,401,{error:'Please log in again.'});const b=await body(req),save=cleanState(b.save);if(!Number.isInteger(b.revision)||b.revision<0)return json(res,400,{error:'Invalid save version'});const r=await db.query('UPDATE players SET save=$1,revision=revision+1,best_score=GREATEST(best_score,$2) WHERE id=$3 AND revision=$4 RETURNING revision',[JSON.stringify(save),Math.max(save.score,save.best),p.id,b.revision]);if(!r.rows.length)return json(res,409,{error:'Another tab saved newer progress. Reload to continue.'});return json(res,200,{revision:r.rows[0].revision})}
 if(path==='/api/leaderboard'&&req.method==='GET'){const r=await db.query('SELECT username,best_score FROM players WHERE best_score>0 ORDER BY best_score DESC,username ASC LIMIT 50');return json(res,200,{players:r.rows.map((p,i)=>({rank:i+1,username:p.username,score:Number(p.best_score)}))})}
 return json(res,404,{error:'Not found'});
 }catch(e){if(e.code==='23505')return json(res,409,{error:'That username is already taken.'});if(e.status)return json(res,e.status,{error:e.message});console.error('Request failed:',e.code||e.name);return json(res,503,{error:'Service temporarily unavailable. Please try again.'})}}
}
if(process.env.NODE_ENV!=='test'){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL must be configured');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:10000});db.on('error',e=>console.error('Database connection error:',e.code));await initDB(db);
 setInterval(()=>db.query('DELETE FROM sessions WHERE expires_at<NOW()').catch(()=>{}),3600000).unref();
 createServer(app(db,{secure:process.env.NODE_ENV==='production'})).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Pigeon Patrol and database ready'));
}
