import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {extname,resolve,normalize} from 'node:path';
import {canMatch,explain} from './matching.js';

export const db=new DatabaseSync(process.env.DB||'sectionswap.db');
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pass TEXT NOT NULL,role TEXT DEFAULT 'student',uni TEXT,campus TEXT,program TEXT,semester INT,banned INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,uid INT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,uid INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,course TEXT NOT NULL,cname TEXT NOT NULL,term TEXT NOT NULL,cur TEXT NOT NULL,want TEXT NOT NULL,reason TEXT,notes TEXT,status TEXT DEFAULT 'draft',expires TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS rq ON requests(course,term,status);
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY,a INT REFERENCES requests(id) ON DELETE CASCADE,b INT REFERENCES requests(id) ON DELETE CASCADE,status TEXT DEFAULT 'pending',outcome TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(a,b));
CREATE TABLE IF NOT EXISTS responses(mid INT REFERENCES matches(id) ON DELETE CASCADE,uid INT,interest TEXT DEFAULT 'none',confirm INT DEFAULT 0,PRIMARY KEY(mid,uid));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,uid INT REFERENCES users(id) ON DELETE CASCADE,cat TEXT,text TEXT,link TEXT,read INT DEFAULT 0,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS blocks(a INT,b INT,PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,reporter INT,target INT,reason TEXT,status TEXT DEFAULT 'open',created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,admin INT,action TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);`);

db.exec(`CREATE TABLE IF NOT EXISTS offerings(id INTEGER PRIMARY KEY,course TEXT,cname TEXT,term TEXT,section TEXT,day TEXT,start TEXT,end TEXT,UNIQUE(course,term,section,day,start));
CREATE TABLE IF NOT EXISTS slots(id INTEGER PRIMARY KEY,uid INT REFERENCES users(id) ON DELETE CASCADE,course TEXT,section TEXT,day TEXT,start TEXT,end TEXT);`);
if(db.prepare('PRAGMA user_version').get().user_version<2){for(const s of['ALTER TABLE requests ADD COLUMN alt TEXT','ALTER TABLE requests ADD COLUMN days TEXT',"ALTER TABLE requests ADD COLUMN tt TEXT DEFAULT 'optional'",'ALTER TABLE requests ADD COLUMN warned INT DEFAULT 0','ALTER TABLE users ADD COLUMN term TEXT'])db.exec(s);db.exec('PRAGMA user_version=2')}
db.exec('CREATE TABLE IF NOT EXISTS terms(id INTEGER PRIMARY KEY,name TEXT UNIQUE,reg_deadline TEXT,warned INT DEFAULT 0)');
if(db.prepare('PRAGMA user_version').get().user_version<3){for(const s of['ALTER TABLE users ADD COLUMN avatar TEXT','ALTER TABLE users ADD COLUMN verified INT DEFAULT 1','ALTER TABLE users ADD COLUMN vtoken TEXT'])db.exec(s);db.exec('PRAGMA user_version=3')}
const q=(s,...p)=>db.prepare(s).all(...p), one=(s,...p)=>db.prepare(s).get(...p), run=(s,...p)=>db.prepare(s).run(...p);
class E extends Error{constructor(c,m){super(m);this.c=c}}
// Email goes through a webhook you configure (MAIL_WEBHOOK=https://... receives {to,subject,text}). Unset = logged to console only.
const MAIL=process.env.MAIL_WEBHOOK;
const mail=async(to,subject,text)=>{if(!MAIL||String(to).endsWith('@demo.test')){console.log(`[mail not configured] to=${to} | ${subject} | ${text}`);return}try{await fetch(MAIL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to,subject,text})})}catch{console.error('mail delivery failed')}};
const notify=(uid,cat,text,link)=>{run('INSERT INTO notifications(uid,cat,text,link) VALUES(?,?,?,?)',uid,cat,text,link);if(MAIL){const u=one('SELECT email FROM users WHERE id=?',uid);if(u)mail(u.email,'SectionSwap: '+cat,text)}};
const hp=p=>{const s=randomBytes(16).toString('hex');return s+':'+scryptSync(p,s,32).toString('hex')};
const vp=(p,h)=>{const[s,k]=h.split(':');return timingSafeEqual(Buffer.from(k,'hex'),scryptSync(p,s,32))};
const sha=t=>createHash('sha256').update(t).digest('hex');
const today=()=>new Date().toISOString().slice(0,10);
const ST="CASE WHEN status='active' AND expires<date('now') THEN 'expired' ELSE status END";
const audit=(u,a)=>run('INSERT INTO audit(admin,action) VALUES(?,?)',u.id,a);

const tm=t=>{const[h,m]=String(t).split(':');return h*60+ +m};
// Would moving into `section` clash with this student's other (self-entered, unverified) classes?
const clash=(uid,course,term,section)=>{const nw=q('SELECT day,start,end FROM offerings WHERE course=? AND term=? AND section=?',course,term,section),my=q('SELECT * FROM slots WHERE uid=? AND course!=?',uid,course);
  if(!nw.length||!my.length)return{s:'unknown',d:[]};const d=[];
  for(const a of nw)for(const b of my)if(a.day===b.day&&tm(a.start)<tm(b.end)&&tm(b.start)<tm(a.end))d.push(`${a.day} ${a.start}-${a.end} overlaps ${b.course} ${b.start}-${b.end}`);
  return{s:d.length?'clash':'ok',d}};
const catCheck=o=>{if(!one('SELECT 1 x FROM offerings WHERE course=? AND term=?',o.course,o.term))return;for(const k of['cur','want'])if(!one('SELECT 1 x FROM offerings WHERE course=? AND term=? AND section=?',o.course,o.term,o[k]))throw new E(400,`Section ${o[k]} does not exist for ${o.course} in ${o.term}`)};
function findMatches(r){
  if(r.status!=='active')return 0;let n=0;const bl=q('SELECT a,b FROM blocks').map(x=>[x.a,x.b]);
  for(const o of q("SELECT * FROM requests WHERE status='active' AND course=? AND term=? AND id!=?",r.course,r.term,r.id)){
    if(!canMatch(r,o,bl)||[r,o].some(x=>x.tt==='required'&&clash(x.uid,x.course,x.term,x.want).s==='clash'))continue;const[a,b]=r.id<o.id?[r,o]:[o,r];
    if(one('SELECT 1 x FROM matches WHERE a=? AND b=?',a.id,b.id))continue;
    const m=run('INSERT INTO matches(a,b) VALUES(?,?)',a.id,b.id).lastInsertRowid;
    for(const u of[a.uid,b.uid]){run('INSERT INTO responses(mid,uid) VALUES(?,?)',m,u);notify(u,'match',`New potential match for ${r.course}`,'#/matches')}
    n++}
  return n}
function setStatus(r,s){
  run('UPDATE requests SET status=? WHERE id=?',s,r.id);
  if(s!=='active')for(const m of q("SELECT m.id,ra.uid ua,rb.uid ub FROM matches m JOIN requests ra ON ra.id=m.a JOIN requests rb ON rb.id=m.b WHERE (m.a=? OR m.b=?) AND m.status IN('pending','mutual')",r.id,r.id)){
    run("UPDATE matches SET status='closed' WHERE id=?",m.id);notify(m.ua===r.uid?m.ub:m.ua,'match',`A match for ${r.course} was closed (request changed)`,'#/history')}
  else findMatches(one('SELECT * FROM requests WHERE id=?',r.id))}

const str=(v,n=80)=>String(v??'').trim().slice(0,n);
function clean(b,part){
  const o={};for(const k of['course','cname','term','cur','want'])if(!part||b[k]!==undefined){o[k]=str(b[k]);if(!o[k])throw new E(400,`${k==='cname'?'Course name':k} is required`)}
  if(o.course)o.course=o.course.toUpperCase();
  for(const k of['reason','notes','alt','days'])if(b[k]!==undefined)o[k]=str(b[k],500);if(b.tt!==undefined)o.tt=['required','preferred','optional'].includes(b.tt)?b.tt:'optional';
  if(b.expires!==undefined){const e=str(b.expires,10);if(e&&(!/^\d{4}-\d{2}-\d{2}$/.test(e)||e<today()))throw new E(400,'Expiry must be a future date');o.expires=e||null}
  return o}

const routes=[];const R=(m,p,f,o={})=>routes.push({m,o,f,p,re:new RegExp('^/api/v1'+p.replace(':id','(\\d+)').replace(':a','(\\w+)')+'$')});
const own=c=>{const r=one('SELECT * FROM requests WHERE id=?',c.p[0]);if(!r||r.uid!==c.user.id)throw new E(404,'Request not found');return r};
const sess=(c,uid)=>{const t=randomBytes(32).toString('hex');run('INSERT INTO sessions(h,uid) VALUES(?,?)',sha(t),uid);c.h['set-cookie']=`ss=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`};
const resets=new Map();

// ---- auth & profile
R('POST','/auth/register',c=>{const b=c.body,email=str(b.email,120).toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw new E(400,'Valid email required');
  if(str(b.password,200).length<8)throw new E(400,'Password must be at least 8 characters');
  if(!str(b.name))throw new E(400,'Display name required');
  if(one('SELECT 1 x FROM users WHERE email=?',email))throw new E(409,'Email already registered');
  const id=run('INSERT INTO users(email,name,pass,uni,campus,program,semester) VALUES(?,?,?,?,?,?,?)',email,str(b.name),hp(b.password),str(b.uni),str(b.campus),str(b.program),parseInt(b.semester)||null).lastInsertRowid;
  if(MAIL){const t=randomBytes(16).toString('hex');run('UPDATE users SET verified=0,vtoken=? WHERE id=?',sha(t),id);mail(email,'Verify your SectionSwap account',`Open: http://${c.req.headers.host}/api/v1/auth/verify?token=${t}`);return{ok:1,verify:1}}
  sess(c,id);return{ok:1}});
R('GET','/auth/verify',c=>{const u=one('SELECT id FROM users WHERE vtoken=?',sha(String(c.q.token||'')));if(!u)throw new E(400,'Invalid or already used link');run('UPDATE users SET verified=1,vtoken=NULL WHERE id=?',u.id);c.loc='/';return{ok:1}});
R('POST','/auth/login',c=>{const u=one('SELECT * FROM users WHERE email=?',str(c.body.email,120).toLowerCase());
  if(!u||u.banned||!vp(String(c.body.password||''),u.pass))throw new E(401,'Invalid email or password');if(!u.verified)throw new E(403,'Please verify your email first (check your inbox)');sess(c,u.id);return{ok:1}});
R('POST','/auth/logout',c=>{const m=(c.req.headers.cookie||'').match(/ss=(\w+)/);if(m)run('DELETE FROM sessions WHERE h=?',sha(m[1]));c.h['set-cookie']='ss=; Max-Age=0; Path=/';return{ok:1}});
R('POST','/auth/forgot',c=>{const u=one('SELECT id FROM users WHERE email=?',str(c.body.email,120).toLowerCase());
  if(u){const t=randomBytes(16).toString('hex');resets.set(t,u.id);mail(str(c.body.email,120).toLowerCase(),'Reset your SectionSwap password',`Reset token: ${t}`)}return{ok:1}});
R('POST','/auth/reset',c=>{const id=resets.get(c.body.token);if(!id||str(c.body.password,200).length<8)throw new E(400,'Invalid token or short password');
  run('UPDATE users SET pass=? WHERE id=?',hp(c.body.password),id);run('DELETE FROM sessions WHERE uid=?',id);resets.delete(c.body.token);return{ok:1}});
R('GET','/me',c=>{const{pass,...u}=c.user;return{user:u,unread:one('SELECT COUNT(*) n FROM notifications WHERE uid=? AND read=0',u.id).n}},{auth:1});
R('PATCH','/me',c=>{const b=c.body;if(b.avatar!==undefined){const a=String(b.avatar);if(a&&(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(a)||a.length>60000))throw new E(400,'Image must be a small PNG/JPEG/WebP');run('UPDATE users SET avatar=? WHERE id=?',a||null,c.user.id);if(Object.keys(b).length===1)return{ok:1}}run('UPDATE users SET name=?,uni=?,campus=?,program=?,semester=?,term=? WHERE id=?',str(b.name)||c.user.name,str(b.uni),str(b.campus),str(b.program),parseInt(b.semester)||null,str(b.term),c.user.id);return{ok:1}},{auth:1});
R('DELETE','/me',c=>{run('DELETE FROM users WHERE id=?',c.user.id);c.h['set-cookie']='ss=; Max-Age=0; Path=/';return{ok:1}},{auth:1});

// ---- requests
R('POST','/requests',c=>{const o=clean(c.body);if(o.cur.toLowerCase()===o.want.toLowerCase())throw new E(400,'Current and desired section must differ');catCheck(o);
  if(one("SELECT 1 x FROM requests WHERE uid=? AND course=? AND term=? AND status IN('draft','active','paused')",c.user.id,o.course,o.term))throw new E(409,'You already have an open request for this course and term');
  const id=run('INSERT INTO requests(uid,course,cname,term,cur,want,reason,notes,expires,status,alt,days,tt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',c.user.id,o.course,o.cname,o.term,o.cur,o.want,o.reason||null,o.notes||null,o.expires||null,'draft',o.alt||null,o.days||null,o.tt||'optional').lastInsertRowid;
  if(c.body.publish)setStatus(one('SELECT * FROM requests WHERE id=?',id),'active');return{id}},{auth:1});
R('GET','/requests/mine',c=>({items:q(`SELECT r.*,${ST} st,(SELECT COUNT(*) FROM matches m WHERE (m.a=r.id OR m.b=r.id) AND m.status NOT IN('closed','cancelled','declined')) matches FROM requests r WHERE uid=? ORDER BY id DESC`,c.user.id)}),{auth:1});
R('GET','/requests',c=>{const f=c.q,w=["status='active'","(expires IS NULL OR expires>=date('now'))"],p=[];
  for(const[k,col]of[['term','term'],['cur','cur'],['want','want'],['tt','tt']])if(f[k]){w.push(`${col}=?`);p.push(f[k])}
  if(f.since){w.push('created>=?');p.push(f.since)}if(f.q){w.push('(course LIKE ? OR cname LIKE ?)');p.push(`%${f.q}%`,`%${f.q}%`)}
  const pg=Math.max(1,parseInt(f.page)||1),t=one(`SELECT COUNT(*) n FROM requests WHERE ${w.join(' AND ')}`,...p).n;
  return{total:t,page:pg,items:q(`SELECT r.id,course,cname,r.term,cur,want,reason,alt,days,expires,created,u.name owner,u.uni,u.campus FROM requests r JOIN users u ON u.id=r.uid WHERE ${w.join(' AND ').replace(/\b(status|expires|term|cur|want|course|cname)\b/g,'r.$1')} ORDER BY ${f.sort==='expiry'?'r.expires IS NULL,r.expires':'r.id DESC'} LIMIT 8 OFFSET ?`,...p,(pg-1)*8)}},{auth:1});
R('PATCH','/requests/:id',c=>{const r=own(c),o=clean(c.body,1),n={...r,...o};if(n.cur.toLowerCase()===n.want.toLowerCase())throw new E(400,'Current and desired section must differ');catCheck(n);
  run('UPDATE requests SET course=?,cname=?,term=?,cur=?,want=?,reason=?,notes=?,expires=?,alt=?,days=?,tt=? WHERE id=?',n.course,n.cname,n.term,n.cur,n.want,n.reason,n.notes,n.expires,n.alt,n.days,n.tt,r.id);
  if(r.cur!==n.cur||r.want!==n.want||r.course!==n.course||r.term!==n.term){setStatus(r,'paused');if(r.status==='active'||c.body.publish)setStatus(n,'active')}
  else if(c.body.publish)setStatus(n,'active');return{ok:1}},{auth:1});
R('POST','/requests/:id/:a',c=>{const r=own(c),a=c.p[1];if(a==='find')return{found:findMatches(r)};const s={pause:'paused',resume:'active',cancel:'cancelled',renew:'active',publish:'active'}[a];if(!s)throw new E(400,'Bad action');
  if(a==='renew')run("UPDATE requests SET expires=date('now','+14 days'),warned=0 WHERE id=?",r.id);setStatus(r,s);return{ok:1}},{auth:1});
R('DELETE','/requests/:id',c=>{const r=own(c);if(r.status!=='draft')throw new E(409,'Only drafts can be deleted');run('DELETE FROM requests WHERE id=?',r.id);return{ok:1}},{auth:1});

// ---- matches & consent
const mine=u=>q('SELECT m.*,ra.uid ua,rb.uid ub,ra.course,ra.term,ra.cname,ra.cur ca,ra.want wa,rb.cur cb FROM matches m JOIN requests ra ON ra.id=m.a JOIN requests rb ON rb.id=m.b WHERE ra.uid=? OR rb.uid=? ORDER BY m.id DESC',u,u).map(m=>{
  const A=m.ua===u,oid=A?m.ub:m.ua,cur=A?m.ca:m.cb,want=A?m.wa:m.ca,o=one('SELECT name,email FROM users WHERE id=?',oid);
  return{id:m.id,course:m.course,cname:m.cname,term:m.term,cur,want,status:m.status,outcome:m.outcome,created:m.created,
    my:one('SELECT interest,confirm FROM responses WHERE mid=? AND uid=?',m.id,u),their:one('SELECT interest,confirm FROM responses WHERE mid=? AND uid=?',m.id,oid),
    other:o?.name,contact:['approval_pending','completed'].includes(m.status)?o?.email:null,why:explain(m.course,cur,want),tt:clash(u,m.course,m.term,want)}});
R('GET','/matches',c=>({items:mine(c.user.id)}),{auth:1});
const mrow=c=>{const m=one('SELECT m.*,ra.uid ua,rb.uid ub FROM matches m JOIN requests ra ON ra.id=m.a JOIN requests rb ON rb.id=m.b WHERE m.id=?',c.p[0]);if(!m||![m.ua,m.ub].includes(c.user.id))throw new E(404,'Match not found');return m};
R('POST','/matches/:id/:a',c=>{const m=mrow(c),a=c.p[1],me=c.user.id,ot=me===m.ua?m.ub:m.ua,id=m.id;
  const set=(f,v)=>run(`UPDATE responses SET ${f}=? WHERE mid=? AND uid=?`,v,id,me),rs=()=>q('SELECT * FROM responses WHERE mid=?',id);
  if(a==='block'){run('INSERT OR IGNORE INTO blocks VALUES(?,?)',me,ot);run("UPDATE matches SET status='cancelled' WHERE id=?",id);return{ok:1}}
  if(a==='report'){run('INSERT INTO reports(reporter,target,reason) VALUES(?,?,?)',me,ot,str(c.body.reason,300)||'No reason given');return{ok:1}}
  if(['cancelled','closed','declined','completed'].includes(m.status))throw new E(409,'This match is already closed');
  const mine_=rs().find(r=>r.uid===me),oth=rs().find(r=>r.uid===ot);let st=null,msg;
  if(a==='interest'){set('interest','interested');msg='showed interest in a swap'}
  else if(a==='withdraw'){set('interest','none');set('confirm',0);msg='withdrew interest'}
  else if(a==='decline'){set('interest','declined');st='declined';msg='declined the match'}
  else if(a==='confirm'){if(mine_.interest!=='interested'||oth.interest!=='interested')throw new E(409,'Both students must express interest first');set('confirm',1);msg='confirmed the swap'}
  else if(a==='cancel'){st='cancelled';msg='cancelled the match'}
  else if(a==='outcome'){if(m.status!=='approval_pending')throw new E(409,'Not awaiting approval');st='completed';run('UPDATE matches SET outcome=? WHERE id=?','Self-reported: '+(str(c.body.note,200)||'approved by university'),id);msg='reported the swap as completed (self-reported)'}
  else throw new E(400,'Bad action');
  if(!st){const r=rs();st=r.every(x=>x.confirm)?'approval_pending':r.every(x=>x.interest==='interested')?'mutual':'pending'}
  run('UPDATE matches SET status=? WHERE id=?',st,id);notify(ot,'consent',`The other student ${msg} (${m.id?one('SELECT course FROM requests WHERE id=?',m.a).course:''})`,'#/matches');return{status:st}},{auth:1});

// ---- notifications, history
R('GET','/notifications',c=>({items:q(`SELECT * FROM notifications WHERE uid=? ${c.q.cat?'AND cat=?':''} ORDER BY id DESC LIMIT 100`,c.user.id,...(c.q.cat?[c.q.cat]:[]))}),{auth:1});
R('POST','/notifications/read',c=>{run('UPDATE notifications SET read=1 WHERE uid=?',c.user.id);return{ok:1}},{auth:1});
R('GET','/history',c=>({requests:q(`SELECT *,${ST} st FROM requests WHERE uid=? AND (${ST}) IN('cancelled','expired')`,c.user.id),matches:mine(c.user.id).filter(m=>['declined','cancelled','closed','completed'].includes(m.status))}),{auth:1});

// ---- admin
R('GET','/admin/stats',()=>({users:one('SELECT COUNT(*) n FROM users').n,active:one("SELECT COUNT(*) n FROM requests WHERE status='active'").n,matches:one('SELECT COUNT(*) n FROM matches').n,completed:one("SELECT COUNT(*) n FROM matches WHERE status='completed'").n,openReports:one("SELECT COUNT(*) n FROM reports WHERE status='open'").n}),{admin:1});
R('GET','/admin/reports',()=>({items:q("SELECT r.*,u.name tname,u.email temail,u.banned FROM reports r JOIN users u ON u.id=r.target ORDER BY r.status='open' DESC,r.id DESC LIMIT 50"),audit:q('SELECT * FROM audit ORDER BY id DESC LIMIT 15')}),{admin:1});
R('POST','/admin/reports/:id/:a',c=>{const r=one('SELECT * FROM reports WHERE id=?',c.p[0]);if(!r)throw new E(404,'Not found');
  if(c.p[1]==='ban'){run('UPDATE users SET banned=1 WHERE id=?',r.target);run('DELETE FROM sessions WHERE uid=?',r.target);for(const x of q("SELECT * FROM requests WHERE uid=? AND status='active'",r.target))setStatus(x,'cancelled')}
  else if(c.p[1]!=='dismiss')throw new E(400,'Bad action');
  run("UPDATE reports SET status='resolved' WHERE id=?",r.id);audit(c.user,`${c.p[1]} report #${r.id} (user ${r.target})`);notify(r.reporter,'moderation','Your report was reviewed by a moderator','#/notifs');return{ok:1}},{admin:1});

// ---- catalog, timetable (self-entered = unverified), admin tools, docs
R('GET','/catalog',()=>({items:q('SELECT * FROM offerings ORDER BY course,term,section')}),{auth:1});
const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],TM=/^([01]\d|2[0-3]):[0-5]\d$/;
const slot=b=>{const s={course:str(b.course,20).toUpperCase(),section:str(b.section,20),day:str(b.day,3),start:str(b.start,5),end:str(b.end,5)};if(!s.course||!DAYS.includes(s.day)||!TM.test(s.start)||!TM.test(s.end)||s.start>=s.end)throw new E(400,'Valid course, weekday and start < end time required');return s};
const rematch=u=>{for(const r of q("SELECT * FROM requests WHERE uid=? AND status='active'",u))findMatches(r)};
R('GET','/timetable',c=>({items:q('SELECT * FROM slots WHERE uid=? ORDER BY day,start',c.user.id)}),{auth:1});
R('POST','/timetable',c=>{const s=slot(c.body);run('INSERT INTO slots(uid,course,section,day,start,end) VALUES(?,?,?,?,?,?)',c.user.id,s.course,s.section,s.day,s.start,s.end);rematch(c.user.id);return{ok:1}},{auth:1});
R('DELETE','/timetable/:id',c=>{run('DELETE FROM slots WHERE id=? AND uid=?',c.p[0],c.user.id);rematch(c.user.id);return{ok:1}},{auth:1});
R('POST','/admin/offerings',c=>{const b=c.body,s=slot(b),cn=str(b.cname),t=str(b.term);if(!cn||!t)throw new E(400,'Course name and term required');
  try{run('INSERT INTO offerings(course,cname,term,section,day,start,end) VALUES(?,?,?,?,?,?,?)',s.course,cn,t,s.section,s.day,s.start,s.end)}catch{throw new E(409,'Offering already exists')}audit(c.user,`add offering ${s.course} ${t} ${s.section}`);return{ok:1}},{admin:1});
R('DELETE','/admin/offerings/:id',c=>{run('DELETE FROM offerings WHERE id=?',c.p[0]);audit(c.user,`delete offering #${c.p[0]}`);return{ok:1}},{admin:1});
R('GET','/admin/search',c=>{const l=`%${c.q.q||''}%`;return{users:q('SELECT id,email,name,uni,banned,role FROM users WHERE email LIKE ? OR name LIKE ? LIMIT 20',l,l),requests:q(`SELECT r.id,course,cur,want,r.term,${ST} st,u.email FROM requests r JOIN users u ON u.id=r.uid WHERE course LIKE ? OR u.email LIKE ? ORDER BY r.id DESC LIMIT 20`,l,l)}},{admin:1});
R('POST','/admin/requests/:id/remove',c=>{const r=one('SELECT * FROM requests WHERE id=?',c.p[0]);if(!r)throw new E(404,'Not found');setStatus(r,'cancelled');audit(c.user,`removed request #${r.id}`);notify(r.uid,'moderation',`Your ${r.course} request was removed by a moderator`,'#/mine');return{ok:1}},{admin:1});
R('POST','/admin/users/:id/ban',c=>{const u=one('SELECT * FROM users WHERE id=?',c.p[0]);if(!u||u.role==='admin')throw new E(404,'User not found');run('UPDATE users SET banned=1 WHERE id=?',u.id);run('DELETE FROM sessions WHERE uid=?',u.id);for(const x of q("SELECT * FROM requests WHERE uid=? AND status='active'",u.id))setStatus(x,'cancelled');audit(c.user,`banned user #${u.id}`);return{ok:1}},{admin:1});
R('POST','/admin/sweep',c=>{const n=sweep();audit(c.user,`closed ${n} expired requests`);return{closed:n}},{admin:1});
R('GET','/terms',()=>({items:q('SELECT id,name,reg_deadline FROM terms ORDER BY reg_deadline')}),{auth:1});
R('POST','/admin/terms',c=>{const n=str(c.body.name),d=str(c.body.reg_deadline,10);if(!n||!/^\d{4}-\d{2}-\d{2}$/.test(d))throw new E(400,'Term name and YYYY-MM-DD deadline required');run('INSERT OR REPLACE INTO terms(name,reg_deadline,warned) VALUES(?,?,0)',n,d);audit(c.user,`set registration deadline ${n} ${d}`);return{ok:1}},{admin:1});
R('DELETE','/admin/terms/:id',c=>{run('DELETE FROM terms WHERE id=?',c.p[0]);audit(c.user,`delete term #${c.p[0]}`);return{ok:1}},{admin:1});
R('GET','/openapi.json',()=>({openapi:'3.0.3',info:{title:'SectionSwap API',version:'1.0.0',description:'Session-cookie auth (cookie "ss"). Errors are {"error":"message"}.'},servers:[{url:'/'}],components:{securitySchemes:{cookie:{type:'apiKey',in:'cookie',name:'ss'}}},
  paths:routes.reduce((o,r)=>{const p='/api/v1'+r.p.replace(':id','{id}').replace(':a','{action}');(o[p]??={})[r.m.toLowerCase()]={summary:`${r.m} ${r.p}`,tags:[r.p.split('/')[1]],security:r.o.auth||r.o.admin?[{cookie:[]}]:[],parameters:[...(r.p.includes(':id')?[{name:'id',in:'path',required:true,schema:{type:'integer'}}]:[]),...(r.p.includes(':a')?[{name:'action',in:'path',required:true,schema:{type:'string'}}]:[])],responses:{200:{description:'OK'},400:{description:'Validation error'},401:{description:'Not logged in'},403:{description:'Forbidden'}}};return o},{})}));
R('GET','/docs',()=>({version:'v1',note:'All routes under /api/v1. auth: public | user (session cookie) | admin',endpoints:routes.map(r=>({method:r.m,path:'/api/v1'+r.p,auth:r.o.admin?'admin':r.o.auth?'user':'public'}))}));
function sweep(){let n=0;for(const r of q("SELECT * FROM requests WHERE status='active' AND expires<date('now')")){setStatus(r,'expired');n++}
  for(const r of q("SELECT * FROM requests WHERE status='active' AND warned=0 AND expires<=date('now','+2 days')")){notify(r.uid,'expiry',`Your ${r.course} request expires on ${r.expires}`,'#/mine');run('UPDATE requests SET warned=1 WHERE id=?',r.id)}
  for(const t of q("SELECT * FROM terms WHERE warned=0 AND reg_deadline BETWEEN date('now') AND date('now','+3 days')")){for(const x of q("SELECT DISTINCT uid FROM requests WHERE term=? AND status IN('draft','active','paused')",t.name))notify(x.uid,'deadline',`Registration deadline for ${t.name}: ${t.reg_deadline}`,'#/mine');run('UPDATE terms SET warned=1 WHERE id=?',t.id)}return n}

// ---- seed (fictional demo data)
function seed(){if(one('SELECT 1 x FROM users'))return;const mk=(e,n,r='student')=>run('INSERT INTO users(email,name,pass,role,uni,campus,program,semester) VALUES(?,?,?,?,?,?,?,?)',e,n,hp('demo1234'),r,'Demo University','Main Campus','BS Computer Science',3).lastInsertRowid;
  mk('admin@demo.test','Admin Demo','admin');const a=mk('ayesha@demo.test','Ayesha'),b=mk('bilal@demo.test','Bilal'),c=mk('sara@demo.test','Sara');
  const rq=(u,co,n,cu,w)=>run("INSERT INTO requests(uid,course,cname,term,cur,want,reason,status) VALUES(?,?,?,?,?,?,'Timetable clash','draft')",u,co,n,'Fall 2026',cu,w).lastInsertRowid;
  for(const[u,co,n,cu,w]of[[a,'CS201','Data Structures','A','B'],[b,'CS201','Data Structures','B','A'],[c,'MT101','Calculus I','C','A']])setStatus(one('SELECT * FROM requests WHERE id=?',rq(u,co,n,cu,w)),'active')}
seed();sweep();setInterval(sweep,36e5).unref();

// ---- http
const hits=new Map();setInterval(()=>hits.clear(),60000).unref();
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
export function start(port=3000){
  const root=resolve('public');
  return createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x'),c={req,h:{},q:Object.fromEntries(u.searchParams),p:[]};
    const send=(s,d)=>{res.writeHead(s,{'content-type':'application/json','x-content-type-options':'nosniff',...c.h});res.end(JSON.stringify(d))};
    try{
      if(!u.pathname.startsWith('/api/')){let f=resolve(root,'.'+normalize(u.pathname));if(!f.startsWith(root)||!existsSync(f)||f===root)f=resolve(root,'index.html');
        res.writeHead(200,{'content-type':mime[extname(f)]||'text/plain','x-content-type-options':'nosniff'});return res.end(readFileSync(f))}
      const ip=req.socket.remoteAddress,k=ip+(u.pathname.includes('/auth/')?'a':'g'),n=(hits.get(k)||0)+1;hits.set(k,n);
      if(n>(k.endsWith('a')?30:600))throw new E(429,'Too many requests, slow down');
      const r=routes.find(x=>x.m===req.method&&x.re.test(u.pathname));if(!r)throw new E(404,'Not found');
      const m=(req.headers.cookie||'').match(/ss=(\w+)/);
      c.user=m&&one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.h=? AND u.banned=0',sha(m[1]));
      const og=req.headers.origin;if(req.method!=='GET'&&og&&new URL(og).host!==req.headers.host)throw new E(403,'Cross-site request blocked');if(r.o.auth&&!c.user)throw new E(401,'Please log in');if(r.o.admin&&c.user?.role!=='admin')throw new E(403,'Admins only');
      let raw='';if(req.method!=='GET'){for await(const ch of req){raw+=ch;if(raw.length>1e5)throw new E(413,'Too large')}}
      try{c.body=raw?JSON.parse(raw):{}}catch{throw new E(400,'Invalid JSON')}
      c.p=u.pathname.match(r.re).slice(1);const out=r.f(c);if(c.loc){res.writeHead(302,{location:c.loc});return res.end()}send(200,out);
    }catch(e){if(!(e instanceof E))console.error(e);send(e.c||500,{error:e.c?e.message:'Something went wrong'})}
  }).listen(port);
}
if(process.argv[1]?.endsWith('server.js'))start(process.env.PORT||3000).on('listening',()=>console.log('SectionSwap on http://localhost:'+(process.env.PORT||3000)));
