const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'maquisflow.sqlite'));
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  tagline TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  category_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL,
  image_url TEXT DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS tables_restaurant (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  table_number INTEGER NOT NULL,
  UNIQUE(restaurant_id, table_number),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  table_number INTEGER,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
`);

const hash = (p) => crypto.createHash('sha256').update(p).digest('hex');
const count = db.prepare('SELECT COUNT(*) AS n FROM restaurants').get().n;
if (!count) {
  const restaurantId = db.prepare('INSERT INTO restaurants(name,slug,tagline,whatsapp) VALUES(?,?,?,?)').run('Chez Awa','chez-awa','Maquis • Grillades • Spécialités ivoiriennes','2250700000000').lastInsertRowid;
  db.prepare('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(?,?,?,?)').run(restaurantId,'Gérant Chez Awa','admin@chezawa.ci',hash('admin123'));
  const cats = ['Poissons','Viandes','Accompagnements','Boissons'];
  const catIds = {};
  cats.forEach((name,i)=>{catIds[name]=db.prepare('INSERT INTO categories(restaurant_id,name,sort_order) VALUES(?,?,?)').run(restaurantId,name,i).lastInsertRowid;});
  const products = [
    ['Poissons','Poisson braisé entier','Avec attiéké, sauce et crudités',6000],
    ['Viandes','Poulet braisé','Avec attiéké, sauce et crudités',4500],
    ['Accompagnements','Attiéké (portion)','Attiéké nature',1000],
    ['Accompagnements','Alloco (portion)','Banane plantain frite',1000],
    ['Boissons','Coca-Cola (33cl)','Boisson fraîche',1000]
  ];
  for (const [c,n,d,p] of products) db.prepare('INSERT INTO products(restaurant_id,category_id,name,description,price) VALUES(?,?,?,?,?)').run(restaurantId,catIds[c],n,d,p);
  for (let i=1;i<=12;i++) db.prepare('INSERT INTO tables_restaurant(restaurant_id,table_number) VALUES(?,?)').run(restaurantId,i);
}

const sessions = new Map();
function parseCookies(req){ const h=req.headers.cookie||''; return Object.fromEntries(h.split(';').filter(Boolean).map(x=>{const [k,...v]=x.trim().split('=');return [k,v.join('=')]})); }
function userFromReq(req){ const sid=parseCookies(req).mf_session; if(!sid) return null; const s=sessions.get(sid); if(!s) return null; return db.prepare('SELECT u.*, r.name restaurant_name, r.slug restaurant_slug, r.whatsapp restaurant_whatsapp FROM users u JOIN restaurants r ON r.id=u.restaurant_id WHERE u.id=?').get(s.userId); }
function send(res,status,data,headers={}){ const body=JSON.stringify(data); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers}); res.end(body); }
function readBody(req){ return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6) req.destroy();});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});}); }
function requireUser(req,res){ const u=userFromReq(req); if(!u){send(res,401,{error:'Non authentifié'});return null;} return u; }
function money(n){ return `${Number(n).toLocaleString('fr-FR')} FCFA`; }
function whatsappUrl(phone,text){ return `https://wa.me/${phone.replace(/\D/g,'')}?text=${encodeURIComponent(text)}`; }

async function api(req,res,url){
  if(req.method==='POST' && url.pathname==='/api/login'){
    const b=await readBody(req); const u=db.prepare('SELECT * FROM users WHERE email=? AND password_hash=?').get(String(b.email||''),hash(String(b.password||'')));
    if(!u) return send(res,401,{error:'Email ou mot de passe incorrect'});
    const sid=crypto.randomBytes(24).toString('hex'); sessions.set(sid,{userId:u.id,expires:Date.now()+86400000});
    return send(res,200,{ok:true},{'Set-Cookie':`mf_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`});
  }
  if(req.method==='POST' && url.pathname==='/api/logout'){ const sid=parseCookies(req).mf_session; if(sid)sessions.delete(sid); return send(res,200,{ok:true},{'Set-Cookie':'mf_session=; HttpOnly; Path=/; Max-Age=0'}); }
  if(req.method==='GET' && url.pathname==='/api/me'){ const u=userFromReq(req); return send(res,200,{authenticated:!!u,user:u?{id:u.id,name:u.name,email:u.email,restaurantId:u.restaurant_id,restaurantName:u.restaurant_name,slug:u.restaurant_slug,whatsapp:u.restaurant_whatsapp}:null}); }
  if(req.method==='GET' && url.pathname.startsWith('/api/public/')){
    const slug=url.pathname.split('/')[3]; const r=db.prepare('SELECT id,name,slug,tagline,whatsapp FROM restaurants WHERE slug=?').get(slug); if(!r)return send(res,404,{error:'Restaurant introuvable'});
    const cats=db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order,id').all(r.id);
    const products=db.prepare('SELECT id,category_id,name,description,price,image_url,available FROM products WHERE restaurant_id=? ORDER BY id').all(r.id);
    return send(res,200,{restaurant:r,categories:cats,products});
  }
  if(req.method==='POST' && url.pathname==='/api/orders'){
    const b=await readBody(req); const r=db.prepare('SELECT * FROM restaurants WHERE slug=?').get(String(b.slug||'')); if(!r)return send(res,404,{error:'Restaurant introuvable'});
    const items=Array.isArray(b.items)?b.items:[]; if(!items.length)return send(res,400,{error:'Panier vide'});
    const ids=items.map(x=>Number(x.productId)).filter(Boolean); const placeholders=ids.map(()=>'?').join(','); const ps=db.prepare(`SELECT * FROM products WHERE restaurant_id=? AND id IN (${placeholders}) AND available=1`).all(r.id,...ids);
    const map=new Map(ps.map(p=>[p.id,p])); let total=0; const normalized=[];
    for(const it of items){const p=map.get(Number(it.productId)); const q=Math.max(1,Math.min(99,Number(it.quantity)||1)); if(!p)continue; total+=p.price*q; normalized.push({p,q});}
    if(!normalized.length)return send(res,400,{error:'Aucun produit valide'});
    db.exec('BEGIN'); try { const oid=db.prepare('INSERT INTO orders(restaurant_id,table_number,customer_name,customer_phone,total,status,source) VALUES(?,?,?,?,?,?,?)').run(r.id,b.tableNumber?Number(b.tableNumber):null,b.customerName||'',b.customerPhone||'',total,'new','web').lastInsertRowid; const ins=db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?)'); for(const x of normalized)ins.run(oid,x.p.id,x.p.name,x.p.price,x.q); db.exec('COMMIT'); const text=`Bonjour ${r.name} 👋\nJe souhaite commander${b.tableNumber?` pour la table ${b.tableNumber}`:''}:\n\n${normalized.map(x=>`• ${x.q}x ${x.p.name} — ${money(x.p.price*x.q)}`).join('\n')}\n\nTotal : ${money(total)}\nMerci !`; return send(res,201,{orderId:Number(oid),total,whatsappUrl:whatsappUrl(r.whatsapp,text)}); } catch(e){try{db.exec('ROLLBACK')}catch{}; return send(res,500,{error:e.message});}
  }
  const u=requireUser(req,res); if(!u)return;
  if(req.method==='GET' && url.pathname==='/api/dashboard'){
    const rid=u.restaurant_id; const today=db.prepare("SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders WHERE restaurant_id=? AND date(created_at,'localtime')=date('now','localtime')").get(rid); const active=db.prepare("SELECT COUNT(*) n FROM orders WHERE restaurant_id=? AND status IN ('new','preparing')").get(rid).n; const avg=db.prepare("SELECT COALESCE(ROUND(AVG((julianday('now')-julianday(created_at))*1440)),0) minutes FROM orders WHERE restaurant_id=? AND date(created_at,'localtime')=date('now','localtime')").get(rid).minutes; const top=db.prepare('SELECT product_name, SUM(quantity) qty FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.restaurant_id=? GROUP BY product_name ORDER BY qty DESC LIMIT 5').all(rid); const recent=db.prepare('SELECT o.*, GROUP_CONCAT(oi.quantity||"x "||oi.product_name, ", ") items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.restaurant_id=? GROUP BY o.id ORDER BY o.id DESC LIMIT 10').all(rid); return send(res,200,{today,active,avg,top,recent});
  }
  if(req.method==='GET' && url.pathname==='/api/orders'){ const status=url.searchParams.get('status'); let sql='SELECT o.*, GROUP_CONCAT(oi.quantity||"x "||oi.product_name, ", ") items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.restaurant_id=?'; const args=[u.restaurant_id]; if(status){sql+=' AND o.status=?';args.push(status)} sql+=' GROUP BY o.id ORDER BY o.id DESC LIMIT 100'; return send(res,200,{orders:db.prepare(sql).all(...args)}); }
  if(req.method==='PATCH' && url.pathname.startsWith('/api/orders/')){ const id=Number(url.pathname.split('/').pop()); const b=await readBody(req); const ok=db.prepare("UPDATE orders SET status=? WHERE id=? AND restaurant_id=?").run(String(b.status||''),id,u.restaurant_id); return send(res,200,{ok:ok.changes>0}); }
  if(req.method==='GET' && url.pathname==='/api/menu'){ const cats=db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order,id').all(u.restaurant_id); const products=db.prepare('SELECT * FROM products WHERE restaurant_id=? ORDER BY id').all(u.restaurant_id); return send(res,200,{categories:cats,products}); }
  if(req.method==='POST' && url.pathname==='/api/products'){ const b=await readBody(req); const r=db.prepare('INSERT INTO products(restaurant_id,category_id,name,description,price,available) VALUES(?,?,?,?,?,?)').run(u.restaurant_id,b.categoryId||null,b.name,b.description||'',Number(b.price),b.available===false?0:1); return send(res,201,{id:Number(r.lastInsertRowid)}); }
  if(req.method==='PATCH' && url.pathname.startsWith('/api/products/')){ const id=Number(url.pathname.split('/').pop()); const b=await readBody(req); db.prepare('UPDATE products SET name=COALESCE(?,name),description=COALESCE(?,description),price=COALESCE(?,price),available=COALESCE(?,available),category_id=COALESCE(?,category_id) WHERE id=? AND restaurant_id=?').run(b.name??null,b.description??null,b.price!=null?Number(b.price):null,b.available!=null?(b.available?1:0):null,b.categoryId!=null?Number(b.categoryId):null,id,u.restaurant_id); return send(res,200,{ok:true}); }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/products/')){ const id=Number(url.pathname.split('/').pop()); db.prepare('DELETE FROM products WHERE id=? AND restaurant_id=?').run(id,u.restaurant_id); return send(res,200,{ok:true}); }
  if(req.method==='GET' && url.pathname==='/api/tables'){ const tables=db.prepare('SELECT * FROM tables_restaurant WHERE restaurant_id=? ORDER BY table_number').all(u.restaurant_id); return send(res,200,{tables,baseUrl:`${url.origin||''}`}); }
  return send(res,404,{error:'Route inconnue'});
}

function serveStatic(req,res){
  let p=req.url.split('?')[0]; if(p==='/'||p==='/admin')p='/index.html'; if(p==='/restaurant')p='/restaurant.html'; if(p==='/login')p='/login.html'; const file=path.normalize(path.join(PUBLIC,p)); if(!file.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden')}; fs.readFile(file,(e,data)=>{if(e){res.writeHead(404);return res.end('Not found')}; const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}; res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data);});}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost:'+PORT}`); if(url.pathname.startsWith('/api/')) return await api(req,res,url); return serveStatic(req,res);}catch(e){console.error(e);send(res,500,{error:'Erreur serveur'});}});
server.listen(PORT,()=>console.log(`MaquisFlow V1.1 running on http://localhost:${PORT}`));
