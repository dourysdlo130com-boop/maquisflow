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
db.exec('PRAGMA busy_timeout = 5000;');

/* =========================================================
   DATABASE
   ========================================================= */

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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price_delta INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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
  options_text TEXT DEFAULT '',
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
`);

/* =========================================================
   HELPERS
   ========================================================= */

const hash = (p) =>
  crypto.createHash('sha256').update(String(p)).digest('hex');

function money(n) {
  return `${Number(n).toLocaleString('fr-FR')} FCFA`;
}

function parseCookies(req) {
  const h = req.headers.cookie || '';

  return Object.fromEntries(
    h
      .split(';')
      .filter(Boolean)
      .map(x => {
        const [k, ...v] = x.trim().split('=');
        return [k, v.join('=')];
      })
  );
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Requête trop volumineuse'));
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON invalide'));
      }
    });

    req.on('error', reject);
  });
}

function whatsappUrl(phone, text) {
  return `https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function positiveInt(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(0, Math.floor(n));
}

/* =========================================================
   RESTAURANT INITIALIZATION / MIGRATION
   ========================================================= */

const restaurantCount =
  db.prepare('SELECT COUNT(*) AS n FROM restaurants').get().n;

if (!restaurantCount) {
  const restaurantId =
    db.prepare(
      'INSERT INTO restaurants(name,slug,tagline,whatsapp) VALUES(?,?,?,?)'
    ).run(
      'LA COUR DES GRANDS',
      'chez-awa',
      'Maquis • Grillades • Spécialités ivoiriennes',
      '2250700000000'
    ).lastInsertRowid;

  db.prepare(
    'INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(?,?,?,?)'
  ).run(
    restaurantId,
    'Gérant LA COUR DES GRANDS',
    'admin@chezawa.ci',
    hash('admin123')
  );

  const cats = [
    'Poissons',
    'Viandes',
    'Accompagnements',
    'Boissons'
  ];

  const catIds = {};

  cats.forEach((name, i) => {
    catIds[name] =
      db.prepare(
        'INSERT INTO categories(restaurant_id,name,sort_order) VALUES(?,?,?)'
      ).run(restaurantId, name, i).lastInsertRowid;
  });

  const products = [
    [
      'Poissons',
      'Poisson braisé entier',
      'Avec attiéké, sauce et crudités',
      6000
    ],
    [
      'Viandes',
      'Poulet braisé',
      'Avec attiéké, sauce et crudités',
      4000
    ],
    [
      'Accompagnements',
      'Attiéké (portion)',
      'Attiéké nature',
      1000
    ],
    [
      'Accompagnements',
      'Alloco (portion)',
      'Banane plantain frite',
      1000
    ],
    [
      'Boissons',
      'Coca-Cola (33cl)',
      'Boisson fraîche',
      1000
    ]
  ];

  for (const [category, name, description, price] of products) {
    db.prepare(
      `INSERT INTO products
       (restaurant_id,category_id,name,description,price,available)
       VALUES(?,?,?,?,?,1)`
    ).run(
      restaurantId,
      catIds[category],
      name,
      description,
      price
    );
  }

  for (let i = 1; i <= 12; i++) {
    db.prepare(
      'INSERT INTO tables_restaurant(restaurant_id,table_number) VALUES(?,?)'
    ).run(restaurantId, i);
  }
} else {
  /*
   * Migration de l'installation existante.
   * On change seulement le nom d'affichage.
   * Le slug "chez-awa" reste volontairement inchangé
   * afin de ne pas casser les liens/QR existants.
   */

  db.prepare(
    `UPDATE restaurants
     SET name='LA COUR DES GRANDS'
     WHERE slug='chez-awa'`
  ).run();

  db.prepare(
    `UPDATE users
     SET name='Gérant LA COUR DES GRANDS'
     WHERE email='admin@chezawa.ci'`
  ).run();
}

/* =========================================================
   DEMO DATA REPAIR
   ========================================================= */

/*
 * Les anciens produits créés sans catégorie restent utilisables,
 * mais on essaie de leur attribuer une catégorie logique.
 */

const restaurant =
  db.prepare(
    `SELECT * FROM restaurants
     WHERE slug='chez-awa'
     LIMIT 1`
  ).get();

if (restaurant) {
  const categoryRows =
    db.prepare(
      `SELECT id,name FROM categories
       WHERE restaurant_id=?
       ORDER BY sort_order,id`
    ).all(restaurant.id);

  const categoryMap = new Map(
    categoryRows.map(c => [c.name.toLowerCase(), c.id])
  );

  const uncategorized =
    db.prepare(
      `SELECT id,name
       FROM products
       WHERE restaurant_id=? AND category_id IS NULL`
    ).all(restaurant.id);

  for (const p of uncategorized) {
    const name = p.name.toLowerCase();

    let categoryName = null;

    if (
      name.includes('poisson')
    ) {
      categoryName = 'poissons';
    } else if (
      name.includes('poulet') ||
      name.includes('viande') ||
      name.includes('brochette')
    ) {
      categoryName = 'viandes';
    } else if (
      name.includes('attiéké') ||
      name.includes('attieke') ||
      name.includes('alloco') ||
      name.includes('frites') ||
      name.includes('salade')
    ) {
      categoryName = 'accompagnements';
    } else if (
      name.includes('coca') ||
      name.includes('eau') ||
      name.includes('boisson')
    ) {
      categoryName = 'boissons';
    }

    if (categoryName && categoryMap.has(categoryName)) {
      db.prepare(
        'UPDATE products SET category_id=? WHERE id=? AND restaurant_id=?'
      ).run(
        categoryMap.get(categoryName),
        p.id,
        restaurant.id
      );
    }
  }
}

/* =========================================================
   SESSIONS
   ========================================================= */

const sessions = new Map();

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');

  sessions.set(sid, {
    userId,
    expires: Date.now() + 86400000
  });

  return sid;
}

function userFromReq(req) {
  const sid = parseCookies(req).mf_session;

  if (!sid) return null;

  const session = sessions.get(sid);

  if (!session) return null;

  if (session.expires <= Date.now()) {
    sessions.delete(sid);
    return null;
  }

  return db.prepare(
    `SELECT
       u.*,
       r.name AS restaurant_name,
       r.slug AS restaurant_slug,
       r.whatsapp AS restaurant_whatsapp
     FROM users u
     JOIN restaurants r ON r.id=u.restaurant_id
     WHERE u.id=?`
  ).get(session.userId);
}

function requireUser(req, res) {
  const user = userFromReq(req);

  if (!user) {
    send(res, 401, {
      error: 'Non authentifié'
    });

    return null;
  }

  return user;
}

/* =========================================================
   PUBLIC API
   ========================================================= */

async function api(req, res, url) {

  /* ---------- LOGIN ---------- */

  if (
    req.method === 'POST' &&
    url.pathname === '/api/login'
  ) {
    try {
      const b = await readBody(req);

      const email = cleanText(b.email, 200).toLowerCase();
      const password = String(b.password || '');

      if (!email || !password) {
        return send(res, 400, {
          error: 'Email et mot de passe requis'
        });
      }

      const user = db.prepare(
        'SELECT * FROM users WHERE email=? AND password_hash=?'
      ).get(
        email,
        hash(password)
      );

      if (!user) {
        return send(res, 401, {
          error: 'Email ou mot de passe incorrect'
        });
      }

      const sid = createSession(user.id);

      return send(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie':
            `mf_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
        }
      );

    } catch (e) {
      return send(res, 400, {
        error: e.message
      });
    }
  }

  /* ---------- LOGOUT ---------- */

  if (
    req.method === 'POST' &&
    url.pathname === '/api/logout'
  ) {
    const sid = parseCookies(req).mf_session;

    if (sid) {
      sessions.delete(sid);
    }

    return send(
      res,
      200,
      { ok: true },
      {
        'Set-Cookie':
          'mf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      }
    );
  }

  /* ---------- CURRENT USER ---------- */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/me'
  ) {
    const u = userFromReq(req);

    return send(res, 200, {
      authenticated: !!u,
      user: u
        ? {
            id: u.id,
            name: u.name,
            email: u.email,
            restaurantId: u.restaurant_id,
            restaurantName: u.restaurant_name,
            slug: u.restaurant_slug,
            whatsapp: u.restaurant_whatsapp
          }
        : null
    });
  }

  /* =======================================================
     PUBLIC RESTAURANT MENU
     ======================================================= */

  if (
    req.method === 'GET' &&
    url.pathname.startsWith('/api/public/')
  ) {
    const slug = cleanText(
      decodeURIComponent(url.pathname.split('/')[3] || ''),
      100
    );

    const r = db.prepare(
      `SELECT id,name,slug,tagline,whatsapp,logo_url
       FROM restaurants
       WHERE slug=?`
    ).get(slug);

    if (!r) {
      return send(res, 404, {
        error: 'Restaurant introuvable'
      });
    }

    const categories = db.prepare(
      `SELECT id,restaurant_id,name,sort_order
       FROM categories
       WHERE restaurant_id=?
       ORDER BY sort_order,id`
    ).all(r.id);

    const products = db.prepare(
      `SELECT
         id,
         category_id,
         name,
         description,
         price,
         image_url,
         available
       FROM products
       WHERE restaurant_id=?
       ORDER BY category_id,id`
    ).all(r.id);

    const options = db.prepare(
      `SELECT
         id,
         product_id,
         name,
         price_delta,
         available,
         sort_order
       FROM product_options
       WHERE product_id IN (
         SELECT id FROM products WHERE restaurant_id=?
       )
       ORDER BY product_id,sort_order,id`
    ).all(r.id);

    return send(res, 200, {
      restaurant: r,
      categories,
      products,
      options
    });
  }

  /* =======================================================
     CREATE ORDER
     ======================================================= */

  if (
    req.method === 'POST' &&
    url.pathname === '/api/orders'
  ) {
    try {
      const b = await readBody(req);

      const slug = cleanText(b.slug, 100);

      const r = db.prepare(
        'SELECT * FROM restaurants WHERE slug=?'
      ).get(slug);

      if (!r) {
        return send(res, 404, {
          error: 'Restaurant introuvable'
        });
      }

      const items = Array.isArray(b.items)
        ? b.items.slice(0, 50)
        : [];

      if (!items.length) {
        return send(res, 400, {
          error: 'Panier vide'
        });
      }

      const productIds = [
        ...new Set(
          items
            .map(x => Number(x.productId))
            .filter(Number.isInteger)
            .filter(x => x > 0)
        )
      ];

      if (!productIds.length) {
        return send(res, 400, {
          error: 'Aucun produit valide'
        });
      }

      const placeholders =
        productIds.map(() => '?').join(',');

      const products = db.prepare(
        `SELECT *
         FROM products
         WHERE restaurant_id=?
         AND id IN (${placeholders})
         AND available=1`
      ).all(
        r.id,
        ...productIds
      );

      const productMap =
        new Map(products.map(p => [p.id, p]));

      const optionIds = [
        ...new Set(
          items.flatMap(item =>
            Array.isArray(item.options)
              ? item.options
                  .map(x => Number(x))
                  .filter(Number.isInteger)
              : []
          )
        )
      ];

      let optionMap = new Map();

      if (optionIds.length) {
        const op = optionIds.map(() => '?').join(',');

        const options = db.prepare(
          `SELECT *
           FROM product_options
           WHERE id IN (${op})
           AND available=1`
        ).all(...optionIds);

        optionMap = new Map(
          options.map(o => [o.id, o])
        );
      }

      let total = 0;
      const normalized = [];

      for (const item of items) {
        const product =
          productMap.get(Number(item.productId));

        if (!product) continue;

        const quantity = Math.max(
          1,
          Math.min(
            99,
            positiveInt(item.quantity, 1)
          )
        );

        const selectedOptions = [];

        if (Array.isArray(item.options)) {
          for (const optionId of item.options) {
            const option =
              optionMap.get(Number(optionId));

            if (!option) continue;

            if (option.product_id !== product.id) {
              continue;
            }

            selectedOptions.push(option);
          }
        }

        let unitPrice = Number(product.price);

        for (const option of selectedOptions) {
          unitPrice += Number(option.price_delta);
        }

        const optionsText =
          selectedOptions.length
            ? selectedOptions
                .map(o =>
                  o.price_delta
                    ? `${o.name} (${o.price_delta > 0 ? '+' : ''}${money(o.price_delta)})`
                    : o.name
                )
                .join(', ')
            : '';

        total += unitPrice * quantity;

        normalized.push({
          product,
          quantity,
          unitPrice,
          optionsText
        });
      }

      if (!normalized.length) {
        return send(res, 400, {
          error:
            'Aucun produit disponible dans votre panier'
        });
      }

      const tableNumber =
        b.tableNumber !== '' &&
        b.tableNumber !== null &&
        b.tableNumber !== undefined
          ? positiveInt(b.tableNumber, 0)
          : null;

      db.exec('BEGIN');

      try {
        const order =
          db.prepare(
            `INSERT INTO orders
             (
               restaurant_id,
               table_number,
               customer_name,
               customer_phone,
               total,
               status,
               source
             )
             VALUES(?,?,?,?,?,?,?)`
          ).run(
            r.id,
            tableNumber || null,
            cleanText(b.customerName, 150),
            cleanText(b.customerPhone, 50),
            total,
            'new',
            'web'
          );

        const orderId =
          Number(order.lastInsertRowid);

        const insertItem =
          db.prepare(
            `INSERT INTO order_items
             (
               order_id,
               product_id,
               product_name,
               unit_price,
               quantity,
               options_text
             )
             VALUES(?,?,?,?,?,?)`
          );

        for (const item of normalized) {
          insertItem.run(
            orderId,
            item.product.id,
            item.product.name,
            item.unitPrice,
            item.quantity,
            item.optionsText
          );
        }

        db.exec('COMMIT');

        const lines = normalized.map(item => {
          const optionPart =
            item.optionsText
              ? ` (${item.optionsText})`
              : '';

          return `• ${item.quantity}x ${item.product.name}${optionPart} — ${money(item.unitPrice * item.quantity)}`;
        });

        const text =
          `Bonjour ${r.name} 👋\n` +
          `Je souhaite commander` +
          `${tableNumber ? ` pour la table ${tableNumber}` : ''}:\n\n` +
          `${lines.join('\n')}\n\n` +
          `Total : ${money(total)}\n` +
          `Merci !`;

        return send(res, 201, {
          orderId,
          total,
          whatsappUrl:
            whatsappUrl(r.whatsapp, text)
        });

      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}

        throw e;
      }

    } catch (e) {
      return send(res, 500, {
        error: e.message
      });
    }
  }

  /* =======================================================
     AUTHENTICATED API
     ======================================================= */

  const u = requireUser(req, res);

  if (!u) return;

  /* ---------- DASHBOARD ---------- */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/dashboard'
  ) {
    const rid = u.restaurant_id;

    const today =
      db.prepare(
        `SELECT
           COUNT(*) AS orders,
           COALESCE(SUM(total),0) AS revenue
         FROM orders
         WHERE restaurant_id=?
         AND date(created_at,'localtime')
             =date('now','localtime')`
      ).get(rid);

    const active =
      db.prepare(
        `SELECT COUNT(*) AS n
         FROM orders
         WHERE restaurant_id=?
         AND status IN ('new','preparing')`
      ).get(rid).n;

    const avg =
      db.prepare(
        `SELECT
           COALESCE(
             ROUND(
               AVG(
                 (julianday('now') -
                  julianday(created_at)) * 1440
               )
             ),
             0
           ) AS minutes
         FROM orders
         WHERE restaurant_id=?
         AND date(created_at,'localtime')
             =date('now','localtime')`
      ).get(rid).minutes;

    const top =
      db.prepare(
        `SELECT
           product_name,
           SUM(quantity) AS qty
         FROM order_items oi
         JOIN orders o ON o.id=oi.order_id
         WHERE o.restaurant_id=?
         GROUP BY product_name
         ORDER BY qty DESC
         LIMIT 5`
      ).all(rid);

    const recent =
      db.prepare(
        `SELECT
           o.*,
           GROUP_CONCAT(
             oi.quantity || 'x ' ||
             oi.product_name ||
             CASE
               WHEN oi.options_text != ''
               THEN ' (' || oi.options_text || ')'
               ELSE ''
             END,
             ', '
           ) AS items
         FROM orders o
         LEFT JOIN order_items oi
           ON oi.order_id=o.id
         WHERE o.restaurant_id=?
         GROUP BY o.id
         ORDER BY o.id DESC
         LIMIT 10`
      ).all(rid);

    return send(res, 200, {
      today,
      active,
      avg,
      top,
      recent
    });
  }

  /* ---------- ORDERS ---------- */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/orders'
  ) {
    const status =
      cleanText(url.searchParams.get('status'), 30);

    let sql =
      `SELECT
         o.*,
         GROUP_CONCAT(
           oi.quantity || 'x ' ||
           oi.product_name ||
           CASE
             WHEN oi.options_text != ''
             THEN ' (' || oi.options_text || ')'
             ELSE ''
           END,
           ', '
         ) AS items
       FROM orders o
       LEFT JOIN order_items oi
         ON oi.order_id=o.id
       WHERE o.restaurant_id=?`;

    const args = [u.restaurant_id];

    if (
      status &&
      ['new', 'preparing', 'done', 'cancelled'].includes(status)
    ) {
      sql += ' AND o.status=?';
      args.push(status);
    }

    sql +=
      ' GROUP BY o.id ORDER BY o.id DESC LIMIT 100';

    return send(res, 200, {
      orders:
        db.prepare(sql).all(...args)
    });
  }

  /* ---------- UPDATE ORDER STATUS ---------- */

  if (
    req.method === 'PATCH' &&
    url.pathname.startsWith('/api/orders/')
  ) {
    const id =
      positiveInt(
        url.pathname.split('/').pop()
      );

    const b = await readBody(req);

    const status =
      cleanText(b.status, 30);

    const allowed =
      ['new', 'preparing', 'done', 'cancelled'];

    if (!allowed.includes(status)) {
      return send(res, 400, {
        error: 'Statut invalide'
      });
    }

    const result =
      db.prepare(
        `UPDATE orders
         SET status=?
         WHERE id=?
         AND restaurant_id=?`
      ).run(
        status,
        id,
        u.restaurant_id
      );

    return send(res, 200, {
      ok: result.changes > 0
    });
  }

  /* =======================================================
     MENU
     ======================================================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/menu'
  ) {
    const categories =
      db.prepare(
        `SELECT *
         FROM categories
         WHERE restaurant_id=?
         ORDER BY sort_order,id`
      ).all(u.restaurant_id);

    const products =
      db.prepare(
        `SELECT *
         FROM products
         WHERE restaurant_id=?
         ORDER BY category_id,id`
      ).all(u.restaurant_id);

    const options =
      db.prepare(
        `SELECT *
         FROM product_options
         WHERE product_id IN (
           SELECT id
           FROM products
           WHERE restaurant_id=?
         )
         ORDER BY product_id,sort_order,id`
      ).all(u.restaurant_id);

    return send(res, 200, {
      categories,
      products,
      options
    });
  }

  /* ---------- CATEGORIES ---------- */

  if (
    req.method === 'POST' &&
    url.pathname === '/api/categories'
  ) {
    const b = await readBody(req);

    const name =
      cleanText(b.name, 100);

    if (!name) {
      return send(res, 400, {
        error: 'Nom de catégorie requis'
      });
    }

    const max =
      db.prepare(
        `SELECT COALESCE(MAX(sort_order),-1) AS n
         FROM categories
         WHERE restaurant_id=?`
      ).get(u.restaurant_id).n;

    const result =
      db.prepare(
        `INSERT INTO categories
         (restaurant_id,name,sort_order)
         VALUES(?,?,?)`
      ).run(
        u.restaurant_id,
        name,
        Number(max) + 1
      );

    return send(res, 201, {
      id: Number(result.lastInsertRowid)
    });
  }

  /* ---------- PRODUCTS ---------- */

  if (
    req.method === 'POST' &&
    url.pathname === '/api/products'
  ) {
    const b = await readBody(req);

    const name =
      cleanText(b.name, 150);

    const description =
      cleanText(b.description, 500);

    const price =
      positiveInt(b.price);

    const categoryId =
      positiveInt(b.categoryId);

    if (!name) {
      return send(res, 400, {
        error: 'Nom du produit requis'
      });
    }

    if (price <= 0) {
      return send(res, 400, {
        error: 'Prix invalide'
      });
    }

    if (!categoryId) {
      return send(res, 400, {
        error: 'Catégorie obligatoire'
      });
    }

    const category =
      db.prepare(
        `SELECT id
         FROM categories
         WHERE id=?
         AND restaurant_id=?`
      ).get(
        categoryId,
        u.restaurant_id
      );

    if (!category) {
      return send(res, 400, {
        error: 'Catégorie invalide'
      });
    }

    const result =
      db.prepare(
        `INSERT INTO products
         (
           restaurant_id,
           category_id,
           name,
           description,
           price,
           available
         )
         VALUES(?,?,?,?,?,?)`
      ).run(
        u.restaurant_id,
        categoryId,
        name,
        description,
        price,
        b.available === false ? 0 : 1
      );

    return send(res, 201, {
      id: Number(result.lastInsertRowid)
    });
  }

  /* ---------- UPDATE PRODUCT ---------- */

  if (
    req.method === 'PATCH' &&
    url.pathname.startsWith('/api/products/')
  ) {
    const id =
      positiveInt(
        url.pathname.split('/').pop()
      );

    const b = await readBody(req);

    const existing =
      db.prepare(
        `SELECT *
         FROM products
         WHERE id=?
         AND restaurant_id=?`
      ).get(
        id,
        u.restaurant_id
      );

    if (!existing) {
      return send(res, 404, {
        error: 'Produit introuvable'
      });
    }

    const name =
      b.name !== undefined
        ? cleanText(b.name, 150)
        : existing.name;

    const description =
      b.description !== undefined
        ? cleanText(b.description, 500)
        : existing.description;

    const price =
      b.price !== undefined
        ? positiveInt(b.price)
        : existing.price;

    const categoryId =
      b.categoryId !== undefined
        ? positiveInt(b.categoryId)
        : existing.category_id;

    const available =
      b.available !== undefined
        ? (b.available ? 1 : 0)
        : existing.available;

    if (!name) {
      return send(res, 400, {
        error: 'Nom du produit requis'
      });
    }

    if (price <= 0) {
      return send(res, 400, {
        error: 'Prix invalide'
      });
    }

    if (!categoryId) {
      return send(res, 400, {
        error: 'Catégorie obligatoire'
      });
    }

    const category =
      db.prepare(
        `SELECT id
         FROM categories
         WHERE id=?
         AND restaurant_id=?`
      ).get(
        categoryId,
        u.restaurant_id
      );

    if (!category) {
      return send(res, 400, {
        error: 'Catégorie invalide'
      });
    }

    db.prepare(
      `UPDATE products
       SET
         name=?,
         description=?,
         price=?,
         available=?,
         category_id=?
       WHERE id=?
       AND restaurant_id=?`
    ).run(
      name,
      description,
      price,
      available,
      categoryId,
      id,
      u.restaurant_id
    );

    return send(res, 200, {
      ok: true
    });
  }

  /* ---------- DELETE PRODUCT ---------- */

  if (
    req.method === 'DELETE' &&
    url.pathname.startsWith('/api/products/')
  ) {
    const id =
      positiveInt(
        url.pathname.split('/').pop()
      );

    db.prepare(
      `DELETE FROM products
       WHERE id=?
       AND restaurant_id=?`
    ).run(
      id,
      u.restaurant_id
    );

    return send(res, 200, {
      ok: true
    });
  }

  /* =======================================================
     PRODUCT OPTIONS
     ======================================================= */

  if (
    req.method === 'POST' &&
    url.pathname.startsWith('/api/products/') &&
    url.pathname.endsWith('/options')
  ) {
    const parts =
      url.pathname.split('/');

    const productId =
      positiveInt(parts[3]);

    const b = await readBody(req);

    const product =
      db.prepare(
        `SELECT id
         FROM products
         WHERE id=?
         AND restaurant_id=?`
      ).get(
        productId,
        u.restaurant_id
      );

    if (!product) {
      return send(res, 404, {
        error: 'Produit introuvable'
      });
    }

    const name =
      cleanText(b.name, 100);

    const priceDelta =
      Number.isFinite(Number(b.priceDelta))
        ? Math.trunc(Number(b.priceDelta))
        : 0;

    if (!name) {
      return send(res, 400, {
        error: 'Nom de l’option requis'
      });
    }

    const result =
      db.prepare(
        `INSERT INTO product_options
         (
           product_id,
           name,
           price_delta,
           available,
           sort_order
         )
         VALUES(?,?,?,?,?)`
      ).run(
        productId,
        name,
        priceDelta,
        b.available === false ? 0 : 1,
        0
      );

    return send(res, 201, {
      id: Number(result.lastInsertRowid)
    });
  }

  if (
    req.method === 'PATCH' &&
    url.pathname.startsWith('/api/options/')
  ) {
    const optionId =
      positiveInt(
        url.pathname.split('/').pop()
      );

    const b = await readBody(req);

    const existing =
      db.prepare(
        `SELECT po.*
         FROM product_options po
         JOIN products p
           ON p.id=po.product_id
         WHERE po.id=?
         AND p.restaurant_id=?`
      ).get(
        optionId,
        u.restaurant_id
      );

    if (!existing) {
      return send(res, 404, {
        error: 'Option introuvable'
      });
    }

    const name =
      b.name !== undefined
        ? cleanText(b.name, 100)
        : existing.name;

    const priceDelta =
      b.priceDelta !== undefined
        ? Math.trunc(Number(b.priceDelta) || 0)
        : existing.price_delta;

    const available =
      b.available !== undefined
        ? (b.available ? 1 : 0)
        : existing.available;

    db.prepare(
      `UPDATE product_options
       SET name=?,price_delta=?,available=?
       WHERE id=?`
    ).run(
      name,
      priceDelta,
      available,
      optionId
    );

    return send(res, 200, {
      ok: true
    });
  }

  if (
    req.method === 'DELETE' &&
    url.pathname.startsWith('/api/options/')
  ) {
    const optionId =
      positiveInt(
        url.pathname.split('/').pop()
      );

    db.prepare(
      `DELETE FROM product_options
       WHERE id=?
       AND product_id IN (
         SELECT p.id
         FROM products p
         WHERE p.restaurant_id=?
       )`
    ).run(
      optionId,
      u.restaurant_id
    );

    return send(res, 200, {
      ok: true
    });
  }

  /* =======================================================
     TABLES
     ======================================================= */

  if (
    req.method === 'GET' &&
    url.pathname === '/api/tables'
  ) {
    const tables =
      db.prepare(
        `SELECT *
         FROM tables_restaurant
         WHERE restaurant_id=?
         ORDER BY table_number`
      ).all(u.restaurant_id);

    return send(res, 200, {
      tables,
      baseUrl: url.origin
    });
  }

  /* =======================================================
     UNKNOWN API ROUTE
     ======================================================= */

  return send(res, 404, {
    error: 'Route inconnue'
  });
}

/* =========================================================
   STATIC FILES
   ========================================================= */

function serveStatic(req, res) {
  let p = req.url.split('?')[0];

  if (p === '/') {
    p = '/index.html';
  }

  if (p === '/admin') {
    p = '/admin.html';
  }

  if (p === '/restaurant') {
    p = '/restaurant.html';
  }

  if (p === '/login') {
    p = '/login.html';
  }

  const file =
    path.normalize(
      path.join(PUBLIC, p)
    );

  if (
    !file.startsWith(PUBLIC + path.sep) &&
    file !== PUBLIC
  ) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      return res.end('Not found');
    }

    const ext =
      path.extname(file).toLowerCase();

    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    res.writeHead(200, {
      'Content-Type':
        types[ext] ||
        'application/octet-stream'
    });

    res.end(data);
  });
}

/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host || `localhost:${PORT}`}`
          );

        if (url.pathname.startsWith('/api/')) {
          return await api(req, res, url);
        }

        return serveStatic(req, res);

      } catch (e) {
        console.error(e);

        return send(res, 500, {
          error: 'Erreur serveur'
        });
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `MaquisFlow V1.2 running on port ${PORT}`
    );
  }
);
