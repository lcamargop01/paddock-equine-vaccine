import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ==================== AUTH HELPERS ====================

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 64; i++) token += chars[Math.floor(Math.random() * chars.length)]
  return token
}

async function getSession(db: D1Database, token: string) {
  if (!token) return null
  const session = await db.prepare(
    `SELECT s.*, CASE WHEN s.role='vet' THEN v.name WHEN s.role='stable' THEN st.name END as user_name
     FROM sessions s
     LEFT JOIN vets v ON s.role='vet' AND s.ref_id = v.id
     LEFT JOIN stables st ON s.role='stable' AND s.ref_id = st.id
     WHERE s.token=? AND s.expires_at > datetime('now')`
  ).bind(token).first()
  return session
}

// ==================== AUTH API ====================

// Get available stables and vets for login screen
app.get('/api/auth/options', async (c) => {
  const db = c.env.DB
  const stables = await db.prepare('SELECT id, name FROM stables WHERE active=1 ORDER BY name').all()
  const vets = await db.prepare('SELECT id, name FROM vets WHERE active=1 ORDER BY name').all()
  return c.json({ stables: stables.results, vets: vets.results })
})

// Login
app.post('/api/auth/login', async (c) => {
  const db = c.env.DB
  const { role, id, pin } = await c.req.json()

  if (!role || !id || !pin) return c.json({ error: 'Role, ID, and PIN are required' }, 400)

  let user: any = null
  if (role === 'vet') {
    user = await db.prepare('SELECT * FROM vets WHERE id=? AND active=1').bind(id).first()
  } else if (role === 'stable') {
    user = await db.prepare('SELECT * FROM stables WHERE id=? AND active=1').bind(id).first()
  }

  if (!user) return c.json({ error: 'User not found' }, 404)
  if (user.pin !== pin) return c.json({ error: 'Invalid PIN' }, 401)

  const token = generateToken()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days

  await db.prepare(
    'INSERT INTO sessions (token, role, ref_id, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, role, id, expiresAt).run()

  return c.json({ token, role, id: user.id, name: user.name })
})

// Validate session
app.get('/api/auth/me', async (c) => {
  const db = c.env.DB
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'No token' }, 401)

  const session = await getSession(db, token)
  if (!session) return c.json({ error: 'Invalid session' }, 401)

  return c.json({ role: session.role, id: session.ref_id, name: session.user_name })
})

// Logout
app.post('/api/auth/logout', async (c) => {
  const db = c.env.DB
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (token) {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(token).run()
  }
  return c.json({ success: true })
})

// ==================== STABLES API ====================

app.get('/api/stables', async (c) => {
  const db = c.env.DB
  const stables = await db.prepare(`
    SELECT s.*, COUNT(DISTINCT o.id) as owner_count,
           COUNT(DISTINCT h.id) as horse_count
    FROM stables s
    LEFT JOIN owners o ON o.stable_id = s.id
    LEFT JOIN horses h ON h.owner_id = o.id AND h.active = 1
    WHERE s.active = 1
    GROUP BY s.id
    ORDER BY s.name
  `).all()
  return c.json(stables.results)
})

app.post('/api/stables', async (c) => {
  const db = c.env.DB
  const { name, contact, address, notes, pin } = await c.req.json()
  if (!name) return c.json({ error: 'Name is required' }, 400)
  try {
    const result = await db.prepare(
      'INSERT INTO stables (name, contact, address, notes, pin) VALUES (?, ?, ?, ?, ?)'
    ).bind(name, contact || null, address || null, notes || null, pin || '1234').run()
    return c.json({ id: result.meta.last_row_id, name }, 201)
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Stable already exists' }, 409)
    throw e
  }
})

app.put('/api/stables/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const params: any[] = []
  if ('name' in body && body.name) { fields.push('name=?'); params.push(body.name) }
  if ('contact' in body) { fields.push('contact=?'); params.push(body.contact || null) }
  if ('address' in body) { fields.push('address=?'); params.push(body.address || null) }
  if ('notes' in body) { fields.push('notes=?'); params.push(body.notes || null) }
  if ('pin' in body && body.pin) { fields.push('pin=?'); params.push(body.pin) }
  if ('active' in body) { fields.push('active=?'); params.push(body.active) }
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400)
  params.push(id)
  await db.prepare(`UPDATE stables SET ${fields.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ success: true })
})

app.delete('/api/stables/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const count = await db.prepare('SELECT COUNT(*) as cnt FROM owners WHERE stable_id=?').bind(id).first() as any
  if (count?.cnt > 0) return c.json({ error: `Cannot delete: stable has ${count.cnt} owner(s)` }, 400)
  await db.prepare('DELETE FROM stables WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== VETS API ====================

app.get('/api/vets', async (c) => {
  const db = c.env.DB
  const vets = await db.prepare(`
    SELECT v.*, COUNT(DISTINCT h.id) as horse_count
    FROM vets v
    LEFT JOIN horses h ON h.vet_id = v.id AND h.active = 1
    WHERE v.active = 1
    GROUP BY v.id
    ORDER BY v.name
  `).all()
  return c.json(vets.results)
})

app.post('/api/vets', async (c) => {
  const db = c.env.DB
  const { name, email, phone, pin } = await c.req.json()
  if (!name) return c.json({ error: 'Name is required' }, 400)
  const result = await db.prepare(
    'INSERT INTO vets (name, email, phone, pin) VALUES (?, ?, ?, ?)'
  ).bind(name, email || null, phone || null, pin || '1234').run()
  return c.json({ id: result.meta.last_row_id, name }, 201)
})

app.put('/api/vets/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const params: any[] = []
  if ('name' in body && body.name) { fields.push('name=?'); params.push(body.name) }
  if ('email' in body) { fields.push('email=?'); params.push(body.email || null) }
  if ('phone' in body) { fields.push('phone=?'); params.push(body.phone || null) }
  if ('pin' in body && body.pin) { fields.push('pin=?'); params.push(body.pin) }
  if ('active' in body) { fields.push('active=?'); params.push(body.active) }
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400)
  params.push(id)
  await db.prepare(`UPDATE vets SET ${fields.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ success: true })
})

// ==================== OWNERS API ====================

app.get('/api/owners', async (c) => {
  const db = c.env.DB
  const stableId = c.req.query('stable_id')
  let query = `
    SELECT o.*, COUNT(h.id) as horse_count, s.name as stable_name
    FROM owners o
    LEFT JOIN horses h ON h.owner_id = o.id AND h.active = 1
    LEFT JOIN stables s ON o.stable_id = s.id
  `
  const params: any[] = []
  if (stableId) {
    query += ' WHERE o.stable_id = ?'
    params.push(stableId)
  }
  query += ' GROUP BY o.id ORDER BY o.name'
  const owners = await db.prepare(query).bind(...params).all()
  return c.json(owners.results)
})

app.post('/api/owners', async (c) => {
  const db = c.env.DB
  const { name, contact, notes, stable_id } = await c.req.json()
  if (!name) return c.json({ error: 'Name is required' }, 400)
  try {
    const result = await db.prepare('INSERT INTO owners (name, contact, notes, stable_id) VALUES (?, ?, ?, ?)')
      .bind(name, contact || null, notes || null, stable_id || null).run()
    return c.json({ id: result.meta.last_row_id, name, contact, notes, stable_id }, 201)
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Owner already exists' }, 409)
    throw e
  }
})

app.put('/api/owners/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const params: any[] = []
  if ('name' in body && body.name) { fields.push('name=?'); params.push(body.name) }
  if ('contact' in body) { fields.push('contact=?'); params.push(body.contact || null) }
  if ('notes' in body) { fields.push('notes=?'); params.push(body.notes || null) }
  if ('stable_id' in body) { fields.push('stable_id=?'); params.push(body.stable_id || null) }
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400)
  params.push(id)
  await db.prepare(`UPDATE owners SET ${fields.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ success: true })
})

app.delete('/api/owners/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const count = await db.prepare('SELECT COUNT(*) as cnt FROM horses WHERE owner_id=? AND active=1').bind(id).first() as any
  if (count?.cnt > 0) return c.json({ error: `Cannot delete: owner has ${count.cnt} active horse(s)` }, 400)
  await db.prepare('DELETE FROM owners WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== HORSES API ====================

app.get('/api/horses', async (c) => {
  const db = c.env.DB
  const search = c.req.query('search') || ''
  const owner = c.req.query('owner') || ''
  const stableId = c.req.query('stable_id') || ''
  const active = c.req.query('active') !== '0' ? 1 : 0
  const sort = c.req.query('sort') || 'name'

  let query = `
    SELECT h.*, o.name as owner_name, s.name as stable_name, v.name as vet_name
    FROM horses h
    JOIN owners o ON h.owner_id = o.id
    LEFT JOIN stables s ON o.stable_id = s.id
    LEFT JOIN vets v ON h.vet_id = v.id
    WHERE h.active = ?
  `
  const params: any[] = [active]

  if (search) {
    query += ` AND (h.name LIKE ? OR h.barn_name LIKE ? OR o.name LIKE ?)`
    const s = `%${search}%`
    params.push(s, s, s)
  }
  if (owner) { query += ` AND o.name = ?`; params.push(owner) }
  if (stableId) { query += ` AND o.stable_id = ?`; params.push(stableId) }

  const sortMap: Record<string, string> = {
    name: 'h.name ASC',
    barn_name: 'h.barn_name ASC',
    owner: 'o.name ASC, h.name ASC',
    stable: 's.name ASC, o.name ASC, h.name ASC',
    updated: 'h.updated_at DESC'
  }
  query += ` ORDER BY ${sortMap[sort] || 'h.name ASC'}`

  const horses = await db.prepare(query).bind(...params).all()
  return c.json(horses.results)
})

app.get('/api/horses/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const horse = await db.prepare(`
    SELECT h.*, o.name as owner_name, s.name as stable_name, v.name as vet_name
    FROM horses h 
    JOIN owners o ON h.owner_id = o.id
    LEFT JOIN stables s ON o.stable_id = s.id
    LEFT JOIN vets v ON h.vet_id = v.id
    WHERE h.id = ?
  `).bind(id).first()
  if (!horse) return c.json({ error: 'Horse not found' }, 404)

  const treatments = await db.prepare(`
    SELECT t.*, tt.name as type_name, tt.category, tt.color, tt.sort_order
    FROM treatments t
    JOIN treatment_types tt ON t.treatment_type_id = tt.id
    WHERE t.horse_id = ?
    ORDER BY tt.sort_order
  `).bind(id).all()

  return c.json({ ...horse, treatments: treatments.results })
})

app.post('/api/horses', async (c) => {
  const db = c.env.DB
  const { name, barn_name, owner_id, notes, vet_id } = await c.req.json()
  if (!name || !owner_id) return c.json({ error: 'Name and owner_id are required' }, 400)

  const result = await db.prepare(
    'INSERT INTO horses (name, barn_name, owner_id, notes, vet_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, barn_name || null, owner_id, notes || null, vet_id || null).run()

  return c.json({ id: result.meta.last_row_id, name, barn_name, owner_id, notes }, 201)
})

app.put('/api/horses/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = ['updated_at=CURRENT_TIMESTAMP']
  const params: any[] = []
  if ('name' in body && body.name) { fields.push('name=?'); params.push(body.name) }
  if ('barn_name' in body) { fields.push('barn_name=?'); params.push(body.barn_name || null) }
  if ('owner_id' in body && body.owner_id) { fields.push('owner_id=?'); params.push(body.owner_id) }
  if ('notes' in body) { fields.push('notes=?'); params.push(body.notes || null) }
  if ('active' in body) { fields.push('active=?'); params.push(body.active) }
  if ('vet_id' in body) { fields.push('vet_id=?'); params.push(body.vet_id || null) }
  params.push(id)
  await db.prepare(`UPDATE horses SET ${fields.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ success: true })
})

app.delete('/api/horses/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM horses WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== TREATMENT TYPES API ====================

app.get('/api/treatment-types', async (c) => {
  const db = c.env.DB
  const types = await db.prepare('SELECT * FROM treatment_types ORDER BY sort_order').all()
  return c.json(types.results)
})

app.post('/api/treatment-types', async (c) => {
  const db = c.env.DB
  const { name, category, sort_order, color } = await c.req.json()
  if (!name) return c.json({ error: 'Name is required' }, 400)
  const result = await db.prepare(
    'INSERT INTO treatment_types (name, category, sort_order, color) VALUES (?, ?, ?, ?)'
  ).bind(name, category || 'vaccine', sort_order || 99, color || '#3A8A4E').run()
  return c.json({ id: result.meta.last_row_id, name }, 201)
})

// ==================== TREATMENTS API ====================

app.get('/api/horses/:id/treatments', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const treatments = await db.prepare(`
    SELECT t.*, tt.name as type_name, tt.category, tt.color, tt.sort_order
    FROM treatments t
    JOIN treatment_types tt ON t.treatment_type_id = tt.id
    WHERE t.horse_id = ?
    ORDER BY tt.sort_order
  `).bind(id).all()
  return c.json(treatments.results)
})

app.put('/api/treatments', async (c) => {
  const db = c.env.DB
  const { horse_id, treatment_type_id, treatment_date, notes } = await c.req.json()
  if (!horse_id || !treatment_type_id) return c.json({ error: 'horse_id and treatment_type_id are required' }, 400)

  await db.prepare(`
    INSERT INTO treatments (horse_id, treatment_type_id, treatment_date, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (horse_id, treatment_type_id)
    DO UPDATE SET treatment_date=excluded.treatment_date, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP
  `).bind(horse_id, treatment_type_id, treatment_date || null, notes || null).run()

  await db.prepare('UPDATE horses SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(horse_id).run()
  return c.json({ success: true })
})

app.delete('/api/treatments/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM treatments WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== GRID VIEW API ====================

app.get('/api/grid', async (c) => {
  const db = c.env.DB
  const search = c.req.query('search') || ''
  const owner = c.req.query('owner') || ''
  const category = c.req.query('category') || ''
  const sort = c.req.query('sort') || 'owner'
  const stableId = c.req.query('stable_id') || ''

  let typesQuery = 'SELECT * FROM treatment_types'
  const typesParams: any[] = []
  if (category) { typesQuery += ' WHERE category = ?'; typesParams.push(category) }
  typesQuery += ' ORDER BY sort_order'
  const types = await db.prepare(typesQuery).bind(...typesParams).all()

  let horsesQuery = `
    SELECT h.*, o.name as owner_name, s.name as stable_name
    FROM horses h
    JOIN owners o ON h.owner_id = o.id
    LEFT JOIN stables s ON o.stable_id = s.id
    WHERE h.active = 1
  `
  const horsesParams: any[] = []
  if (search) {
    horsesQuery += ` AND (h.name LIKE ? OR h.barn_name LIKE ? OR o.name LIKE ?)`
    const s = `%${search}%`
    horsesParams.push(s, s, s)
  }
  if (owner) { horsesQuery += ` AND o.name = ?`; horsesParams.push(owner) }
  if (stableId) { horsesQuery += ` AND o.stable_id = ?`; horsesParams.push(stableId) }

  const sortMap: Record<string, string> = {
    name: 'h.name ASC',
    barn_name: 'h.barn_name ASC',
    owner: 'o.name ASC, h.name ASC',
    stable: 's.name ASC, o.name ASC, h.name ASC',
    updated: 'h.updated_at DESC'
  }
  horsesQuery += ` ORDER BY ${sortMap[sort] || 'o.name ASC, h.name ASC'}`

  const horses = await db.prepare(horsesQuery).bind(...horsesParams).all()

  const allTreatments = await db.prepare(`
    SELECT t.horse_id, t.treatment_type_id, t.treatment_date, t.notes, t.id
    FROM treatments t JOIN horses h ON t.horse_id = h.id WHERE h.active = 1
  `).all()

  const treatmentMap: Record<number, Record<number, any>> = {}
  for (const t of allTreatments.results as any[]) {
    if (!treatmentMap[t.horse_id]) treatmentMap[t.horse_id] = {}
    treatmentMap[t.horse_id][t.treatment_type_id] = { id: t.id, date: t.treatment_date, notes: t.notes }
  }

  return c.json({ types: types.results, horses: horses.results, treatments: treatmentMap })
})

// ==================== BULK OPERATIONS ====================

app.post('/api/treatments/batch', async (c) => {
  const db = c.env.DB
  const { updates } = await c.req.json()
  if (!Array.isArray(updates) || updates.length === 0) return c.json({ error: 'Updates array is required' }, 400)

  const stmts = updates.map((u: any) =>
    db.prepare(`
      INSERT INTO treatments (horse_id, treatment_type_id, treatment_date, notes) VALUES (?, ?, ?, ?)
      ON CONFLICT (horse_id, treatment_type_id) DO UPDATE SET treatment_date=excluded.treatment_date, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP
    `).bind(u.horse_id, u.treatment_type_id, u.treatment_date || null, u.notes || null)
  )
  await db.batch(stmts)
  return c.json({ success: true, count: updates.length })
})

// ==================== FRONTEND ====================

app.get('/*', (c) => {
  return c.html(getHTML())
})

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Paddock Equine Veterinary</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x1F434;</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            'pe-slate': '#475C6E',
            'pe-dark': '#3A4D5E',
            'pe-darker': '#2E3F4E',
            'pe-green': '#3A8A4E',
            'pe-green-dark': '#2E7040',
            'pe-light': '#E8EDF1',
            'pe-accent': '#5B7FA5',
          }
        }
      }
    }
  </script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Inter', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; overscroll-behavior: none; }
    #app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
    .app-header, .app-filters { flex-shrink: 0; }
    .grid-wrapper { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; position: relative; }
    .grid-wrapper table { border-collapse: separate; border-spacing: 0; }
    .grid-wrapper th, .grid-wrapper td { white-space: nowrap; }
    .sticky-col { position: sticky; left: 0; z-index: 10; }
    thead th { position: sticky; top: 0; z-index: 20; }
    thead th.sticky-col { z-index: 30; }
    .date-cell { min-width: 90px; cursor: pointer; transition: all 0.15s; }
    .date-cell:hover { background-color: #E8EDF1 !important; }
    .date-cell:active { transform: scale(0.97); }
    .date-old { color: #dc2626; font-weight: 600; }
    .date-recent { color: #16a34a; }
    .modal-overlay { animation: fadeIn 0.2s ease; }
    .modal-content { animation: slideUp 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .tab-active { border-bottom: 3px solid #3A8A4E; color: white; font-weight: 600; }
    .category-pill { transition: all 0.15s; }
    .category-pill.active { transform: scale(1.05); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
    .search-input:focus { box-shadow: 0 0 0 3px rgba(58, 138, 78, 0.3); }
    input[type="date"] { min-height: 44px; }
    button, .btn { min-height: 44px; }
    .horse-row { transition: background-color 0.15s; }
    .horse-row:active { background-color: #E8EDF1; }
    ::-webkit-scrollbar { height: 4px; width: 4px; }
    ::-webkit-scrollbar-thumb { background: #475C6E; border-radius: 4px; }
    .badge { font-size: 0.65rem; padding: 1px 6px; border-radius: 9999px; font-weight: 600; }
    .toast { animation: slideIn 0.3s ease, fadeOut 0.3s ease 2.7s; }
    @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
    .login-card { animation: slideUp 0.4s ease; }
  </style>
</head>
<body class="bg-gray-100">
  <div id="app"></div>

  <script>
  // ==================== STATE ====================
  const state = {
    // Auth
    auth: null, // { token, role, id, name }
    authOptions: { stables: [], vets: [] },
    loginRole: 'vet',
    
    // Data
    horses: [],
    owners: [],
    stables: [],
    vets: [],
    types: [],
    treatments: {},
    search: '',
    ownerFilter: '',
    stableFilter: '',
    categoryFilter: '',
    sort: 'owner',
    loading: true,
    selectedHorse: null,
    modal: null,
    modalData: null,
  };

  // ==================== API ====================
  const api = {
    headers() {
      const h = { 'Content-Type': 'application/json' };
      if (state.auth?.token) h['Authorization'] = 'Bearer ' + state.auth.token;
      return h;
    },
    async get(url) {
      const r = await fetch(url, { headers: this.headers() });
      return r.json();
    },
    async post(url, data) {
      const r = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(data) });
      return r.json();
    },
    async put(url, data) {
      const r = await fetch(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(data) });
      return r.json();
    },
    async del(url) {
      const r = await fetch(url, { method: 'DELETE', headers: this.headers() });
      return r.json();
    }
  };

  // ==================== AUTH ====================
  async function checkAuth() {
    const saved = localStorage.getItem('pe_auth');
    if (saved) {
      try {
        state.auth = JSON.parse(saved);
        const me = await api.get('/api/auth/me');
        if (me.error) {
          state.auth = null;
          localStorage.removeItem('pe_auth');
        } else {
          state.auth.name = me.name;
          state.auth.role = me.role;
          state.auth.id = me.id;
        }
      } catch {
        state.auth = null;
        localStorage.removeItem('pe_auth');
      }
    }
  }

  async function loadAuthOptions() {
    state.authOptions = await api.get('/api/auth/options');
  }

  async function login() {
    const role = state.loginRole;
    const select = document.getElementById('loginSelect');
    const pinInput = document.getElementById('loginPin');
    if (!select || !pinInput) return;
    const id = parseInt(select.value);
    const pin = pinInput.value;
    if (!id) { showToast('Please select a ' + role, 'error'); return; }
    if (!pin) { showToast('Please enter your PIN', 'error'); return; }
    
    const result = await api.post('/api/auth/login', { role, id, pin });
    if (result.error) { showToast(result.error, 'error'); return; }
    
    state.auth = result;
    localStorage.setItem('pe_auth', JSON.stringify(result));
    showToast('Welcome, ' + result.name + '!');
    await initApp();
  }

  async function logout() {
    await api.post('/api/auth/logout', {});
    state.auth = null;
    localStorage.removeItem('pe_auth');
    state.horses = [];
    state.owners = [];
    state.treatments = {};
    await loadAuthOptions();
    render();
  }

  // ==================== DATA LOADING ====================
  async function loadGrid() {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.ownerFilter) params.set('owner', state.ownerFilter);
    if (state.categoryFilter) params.set('category', state.categoryFilter);
    params.set('sort', state.sort);
    
    // Stable users only see their own horses
    if (state.auth?.role === 'stable') {
      params.set('stable_id', state.auth.id);
    } else if (state.stableFilter) {
      params.set('stable_id', state.stableFilter);
    }

    const data = await api.get('/api/grid?' + params.toString());
    state.types = data.types;
    state.horses = data.horses;
    state.treatments = data.treatments;
    state.loading = false;
    render();
  }

  async function loadOwners() {
    const params = state.auth?.role === 'stable' ? '?stable_id=' + state.auth.id : '';
    state.owners = await api.get('/api/owners' + params);
  }

  async function loadStables() {
    state.stables = await api.get('/api/stables');
  }

  async function loadVets() {
    state.vets = await api.get('/api/vets');
  }

  async function initApp() {
    state.loading = true;
    render();
    await Promise.all([loadGrid(), loadOwners(), loadStables(), loadVets()]);
    render();
  }

  async function init() {
    await loadAuthOptions();
    await checkAuth();
    if (state.auth) {
      await initApp();
    } else {
      render();
    }
  }

  // ==================== HELPERS ====================
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
  }

  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    const d = new Date(dateStr + 'T00:00:00');
    return Math.floor((new Date() - d) / (1000 * 60 * 60 * 24));
  }

  function dateClass(dateStr) {
    const days = daysSince(dateStr);
    if (days > 365) return 'date-old';
    if (days > 270) return 'text-amber-600 font-medium';
    if (days <= 90) return 'date-recent';
    return 'text-gray-700';
  }

  function categoryIcon(cat) {
    const m = { vaccine: 'fa-syringe', test: 'fa-vial', maintenance: 'fa-tooth', injection: 'fa-crosshairs' };
    return m[cat] || 'fa-circle';
  }

  function categoryColor(cat) {
    const m = { vaccine: 'bg-green-600', test: 'bg-blue-500', maintenance: 'bg-purple-500', injection: 'bg-amber-600' };
    return m[cat] || 'bg-gray-500';
  }

  function categoryBgLight(cat) {
    const m = { vaccine: 'bg-green-50 border-green-200', test: 'bg-blue-50 border-blue-200', maintenance: 'bg-purple-50 border-purple-200', injection: 'bg-amber-50 border-amber-200' };
    return m[cat] || 'bg-gray-50 border-gray-200';
  }

  function escHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function showToast(msg, type = 'success') {
    const colors = { success: 'bg-pe-green', error: 'bg-red-600', info: 'bg-pe-accent' };
    const el = document.createElement('div');
    el.className = 'toast fixed top-4 right-4 z-[200] ' + (colors[type]||'bg-pe-green') + ' text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  const isVet = () => state.auth?.role === 'vet';
  const isStable = () => state.auth?.role === 'stable';

  // ==================== SCROLL POSITION ====================
  let savedScrollX = 0, savedScrollY = 0;
  function saveScrollPos() {
    const el = document.querySelector('.grid-wrapper');
    if (el) { savedScrollX = el.scrollLeft; savedScrollY = el.scrollTop; }
  }
  function restoreScrollPos() {
    const el = document.querySelector('.grid-wrapper');
    if (el) { el.scrollLeft = savedScrollX; el.scrollTop = savedScrollY; }
  }

  // ==================== RENDERING ====================
  function render() {
    saveScrollPos();
    const app = document.getElementById('app');
    if (!state.auth) {
      app.innerHTML = renderLoginScreen();
    } else {
      app.innerHTML = renderHeader() + renderFilters() + renderContent() + (state.modal ? renderModal() : '');
      requestAnimationFrame(restoreScrollPos);
    }
  }

  // ==================== LOGIN SCREEN ====================
  function renderLoginScreen() {
    const stables = state.authOptions.stables || [];
    const vets = state.authOptions.vets || [];
    const isVetTab = state.loginRole === 'vet';
    
    const options = isVetTab ? vets : stables;

    return '<div class="min-h-screen bg-gradient-to-b from-pe-slate to-pe-darker flex items-center justify-center p-4">' +
      '<div class="login-card w-full max-w-sm">' +
        '<div class="text-center mb-8">' +
          '<div class="w-20 h-20 bg-pe-green rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">' +
            '<i class="fas fa-horse-head text-white text-3xl"></i>' +
          '</div>' +
          '<h1 class="text-2xl font-bold text-white tracking-wider">PADDOCK EQUINE</h1>' +
          '<p class="text-gray-400 text-xs tracking-[0.2em] uppercase mt-1">Veterinary Services</p>' +
        '</div>' +
        
        '<div class="bg-white rounded-2xl shadow-2xl p-6">' +
          '<div class="flex mb-6 bg-gray-100 rounded-xl p-1">' +
            '<button onclick="switchLoginRole(&apos;vet&apos;)" class="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ' + (isVetTab ? 'bg-pe-green text-white shadow' : 'text-gray-500') + '">' +
              '<i class="fas fa-user-md mr-1.5"></i>Veterinarian' +
            '</button>' +
            '<button onclick="switchLoginRole(&apos;stable&apos;)" class="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ' + (!isVetTab ? 'bg-pe-slate text-white shadow' : 'text-gray-500') + '">' +
              '<i class="fas fa-horse mr-1.5"></i>Stable' +
            '</button>' +
          '</div>' +
          
          '<div class="space-y-4">' +
            '<div>' +
              '<label class="text-xs font-semibold text-gray-600 mb-1.5 block">' + (isVetTab ? 'Select Veterinarian' : 'Select Stable') + '</label>' +
              '<select id="loginSelect" class="w-full px-3 py-3 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none">' +
                '<option value="">Choose...</option>' +
                options.map(function(o) { return '<option value="' + o.id + '">' + escHTML(o.name) + '</option>'; }).join('') +
              '</select>' +
            '</div>' +
            '<div>' +
              '<label class="text-xs font-semibold text-gray-600 mb-1.5 block">PIN</label>' +
              '<input type="password" id="loginPin" placeholder="Enter PIN" maxlength="10" inputmode="numeric"' +
                ' class="w-full px-3 py-3 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none text-center text-lg tracking-[0.5em]"' +
                ' onkeydown="if(event.key===&apos;Enter&apos;)login()" />' +
            '</div>' +
            '<button onclick="login()" class="w-full py-3.5 rounded-xl text-sm font-bold text-white transition-colors ' + (isVetTab ? 'bg-pe-green hover:bg-pe-green-dark' : 'bg-pe-slate hover:bg-pe-dark') + '">' +
              '<i class="fas fa-sign-in-alt mr-1.5"></i>Sign In' +
            '</button>' +
          '</div>' +
        '</div>' +
        
        '<p class="text-center text-gray-500 text-[10px] mt-6">Default PIN: 1234</p>' +
      '</div>' +
    '</div>';
  }

  function switchLoginRole(role) {
    state.loginRole = role;
    render();
  }

  // ==================== HEADER ====================
  function renderHeader() {
    const roleLabel = isVet() ? '<i class="fas fa-user-md mr-1"></i>' + escHTML(state.auth.name) : '<i class="fas fa-horse mr-1"></i>' + escHTML(state.auth.name);
    const roleBadge = isVet() ? 'bg-pe-green' : 'bg-pe-accent';
    
    return '<header class="app-header bg-pe-slate text-white shadow-lg z-50">' +
      '<div class="flex items-center justify-between px-3 py-2">' +
        '<div class="flex items-center gap-2">' +
          '<div class="w-8 h-8 bg-pe-green rounded-full flex items-center justify-center">' +
            '<i class="fas fa-horse-head text-white text-sm"></i>' +
          '</div>' +
          '<div>' +
            '<div class="text-sm font-bold tracking-wider leading-tight">PADDOCK EQUINE</div>' +
            '<div class="text-[9px] tracking-[0.2em] text-gray-300 uppercase">Veterinary Services</div>' +
          '</div>' +
        '</div>' +
        '<div class="flex items-center gap-1">' +
          '<span class="' + roleBadge + ' text-white text-[10px] px-2 py-1 rounded-full font-medium hidden sm:inline-flex items-center gap-1">' + roleLabel + '</span>' +
          (isVet() ? '<button onclick="openAddHorseModal()" class="bg-pe-green hover:bg-pe-green-dark text-white px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"><i class="fas fa-plus"></i><span class="hidden sm:inline">Add Horse</span></button>' : '') +
          '<button onclick="openSettingsModal()" class="p-2 hover:bg-pe-dark rounded-lg transition-colors"><i class="fas fa-cog text-sm"></i></button>' +
          '<button onclick="logout()" class="p-2 hover:bg-pe-dark rounded-lg transition-colors" title="Sign Out"><i class="fas fa-sign-out-alt text-sm"></i></button>' +
        '</div>' +
      '</div>' +
    '</header>';
  }

  // ==================== FILTERS ====================
  function renderFilters() {
    const categories = [
      { key: '', label: 'All', icon: 'fa-th' },
      { key: 'vaccine', label: 'Vaccines', icon: 'fa-syringe' },
      { key: 'test', label: 'Tests', icon: 'fa-vial' },
      { key: 'maintenance', label: 'Maint.', icon: 'fa-tooth' },
      { key: 'injection', label: 'Injections', icon: 'fa-crosshairs' },
    ];

    let html = '<div class="app-filters bg-white shadow-sm border-b">' +
      '<div class="px-3 py-2">' +
        '<div class="relative">' +
          '<i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>' +
          '<input type="search" placeholder="Search horses, owners..." value="' + state.search + '"' +
            ' onInput="debounceSearch(this.value)"' +
            ' class="search-input w-full pl-9 pr-4 py-2.5 bg-gray-100 rounded-xl text-sm border-2 border-transparent focus:border-pe-green focus:bg-white outline-none transition-all" />' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-1 px-3 pb-2 overflow-x-auto">' +
        categories.map(function(cat) {
          return '<button onclick="setCategory(&apos;' + cat.key + '&apos;)" class="category-pill flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ' +
            (state.categoryFilter === cat.key ? 'bg-pe-slate text-white active' : 'bg-gray-100 text-gray-600 hover:bg-gray-200') + '">' +
            '<i class="fas ' + cat.icon + ' text-[10px]"></i>' + cat.label + '</button>';
        }).join('') +
      '</div>' +
      '<div class="flex items-center gap-2 px-3 pb-2">';

    // Stable filter (only for vets)
    if (isVet()) {
      html += '<select onchange="setStableFilter(this.value)" class="text-xs bg-gray-100 border-0 rounded-lg px-2.5 py-1.5 font-medium text-gray-700 outline-none focus:ring-2 focus:ring-pe-green min-h-[32px]">' +
        '<option value=""' + (!state.stableFilter ? ' selected' : '') + '>All Stables</option>' +
        state.stables.map(function(s) { return '<option value="' + s.id + '"' + (state.stableFilter == s.id ? ' selected' : '') + '>' + escHTML(s.name) + '</option>'; }).join('') +
      '</select>';
    }

    html += '<select onchange="setOwnerFilter(this.value)" class="text-xs bg-gray-100 border-0 rounded-lg px-2.5 py-1.5 font-medium text-gray-700 outline-none focus:ring-2 focus:ring-pe-green min-h-[32px]">' +
      '<option value=""' + (!state.ownerFilter ? ' selected' : '') + '>All Owners</option>' +
      state.owners.map(function(o) { return '<option value="' + o.name + '"' + (state.ownerFilter === o.name ? ' selected' : '') + '>' + escHTML(o.name) + '</option>'; }).join('') +
    '</select>' +
    '<select onchange="setSort(this.value)" class="text-xs bg-gray-100 border-0 rounded-lg px-2.5 py-1.5 font-medium text-gray-700 outline-none focus:ring-2 focus:ring-pe-green min-h-[32px]">' +
      '<option value="owner"' + (state.sort === 'owner' ? ' selected' : '') + '>Sort: Owner</option>' +
      '<option value="name"' + (state.sort === 'name' ? ' selected' : '') + '>Sort: Name</option>' +
      '<option value="barn_name"' + (state.sort === 'barn_name' ? ' selected' : '') + '>Sort: Barn Name</option>' +
      (isVet() ? '<option value="stable"' + (state.sort === 'stable' ? ' selected' : '') + '>Sort: Stable</option>' : '') +
    '</select>' +
    '<span class="text-[10px] text-gray-400 ml-auto">' + state.horses.length + ' horses</span>' +
    '</div></div>';

    return html;
  }

  // ==================== CONTENT ====================
  function renderContent() {
    if (state.loading) {
      return '<div class="grid-wrapper flex items-center justify-center"><i class="fas fa-spinner fa-spin text-3xl text-pe-green"></i></div>';
    }
    if (state.horses.length === 0) {
      return '<div class="grid-wrapper flex items-center justify-center text-gray-400"><div class="text-center"><i class="fas fa-horse text-4xl mb-3"></i><p class="text-sm">No horses found</p></div></div>';
    }
    
    const ft = state.types;
    return '<div class="grid-wrapper"><table class="w-full text-xs"><thead>' +
      '<tr class="bg-pe-dark text-white">' +
        '<th class="sticky-col bg-pe-dark px-2 py-2.5 text-left font-semibold min-w-[140px]"><div class="flex flex-col"><span>Horse</span><span class="text-[9px] font-normal text-gray-300">Barn Name</span></div></th>' +
        ft.map(function(t) {
          return '<th class="bg-pe-dark px-2 py-2.5 text-center font-medium"><div class="flex flex-col items-center gap-0.5"><span class="badge ' + categoryColor(t.category) + ' text-white">' + t.category.slice(0,3).toUpperCase() + '</span><span class="text-[10px] leading-tight">' + escHTML(t.name) + '</span></div></th>';
        }).join('') +
        '<th class="bg-pe-dark px-2 py-2.5 text-center font-medium min-w-[60px]"><i class="fas fa-sticky-note text-xs"></i></th>' +
      '</tr></thead><tbody>' +
      renderRows(ft) +
      '<tr><td colspan="' + (ft.length + 2) + '" style="height:80px"></td></tr>' +
    '</tbody></table></div>';
  }

  function renderRows(types) {
    let currentOwner = '';
    let rows = '';
    state.horses.forEach(function(horse, idx) {
      if (horse.owner_name !== currentOwner) {
        currentOwner = horse.owner_name;
        const stableInfo = horse.stable_name ? ' <span class="text-[9px] font-normal text-pe-accent">(' + escHTML(horse.stable_name) + ')</span>' : '';
        rows += '<tr><td colspan="' + (types.length + 2) + '" class="bg-pe-slate/10 px-3 py-1.5 border-t-2 border-pe-slate/20"><span class="text-[11px] font-bold text-pe-slate uppercase tracking-wider"><i class="fas fa-user-circle mr-1"></i>' + escHTML(currentOwner) + stableInfo + '</span></td></tr>';
      }
      const ht = state.treatments[horse.id] || {};
      const bg = idx % 2 === 0 ? 'bg-white' : 'bg-gray-50';
      rows += '<tr class="horse-row ' + bg + ' border-b border-gray-100">' +
        '<td class="sticky-col ' + bg + ' px-2 py-2 border-r border-gray-200"><div class="cursor-pointer" onclick="openHorseDetail(' + horse.id + ')"><div class="font-semibold text-pe-darker text-[11px] leading-tight">' + escHTML(horse.barn_name || horse.name) + '</div><div class="text-[9px] text-gray-400 truncate max-w-[130px]">' + escHTML(horse.name) + '</div></div></td>';
      
      rows += types.map(function(t) {
        const treat = ht[t.id];
        const dateStr = treat ? treat.date : null;
        const display = formatDate(dateStr);
        const cls = dateStr ? dateClass(dateStr) : 'text-gray-300';
        const hasNotes = treat && treat.notes;
        if (isVet()) {
          return '<td class="date-cell px-1 py-2 text-center border-r border-gray-100 relative" onclick="openDatePicker(' + horse.id + ', ' + t.id + ', &apos;' + (dateStr || '') + '&apos;, &apos;' + ((treat?.notes || '').replace(/'/g, '')) + '&apos;)"><div class="text-[11px] ' + cls + '">' + (display || '&mdash;') + '</div>' + (hasNotes ? '<div class="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-pe-green rounded-full"></div>' : '') + '</td>';
        } else {
          return '<td class="px-1 py-2 text-center border-r border-gray-100 relative"><div class="text-[11px] ' + cls + '">' + (display || '&mdash;') + '</div>' + (hasNotes ? '<div class="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-pe-green rounded-full"></div>' : '') + '</td>';
        }
      }).join('');
      
      rows += '<td class="px-1 py-2 text-center">' + (horse.notes ? '<i class="fas fa-sticky-note text-amber-500 text-[10px]" title="' + escHTML(horse.notes) + '"></i>' : '<span class="text-gray-200">&mdash;</span>') + '</td></tr>';
    });
    return rows;
  }

  // ==================== MODALS ====================
  function renderModal() {
    const m = {
      datePicker: renderDatePickerModal,
      addHorse: renderAddHorseModal,
      editHorse: renderEditHorseModal,
      horseDetail: renderHorseDetailModal,
      editOwner: renderEditOwnerModal,
      editStable: renderEditStableModal,
      editVet: renderEditVetModal,
      settings: renderSettingsModal,
    };
    return (m[state.modal] || function(){return '';})();
  }

  function modalWrap(inner) {
    return '<div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)"><div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5 pb-8">' + inner + '</div></div>';
  }

  function modalHeader(title) {
    return '<div class="flex items-center justify-between mb-4"><div class="font-bold text-pe-darker text-lg">' + title + '</div><button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full"><i class="fas fa-times text-gray-400"></i></button></div>';
  }

  // ---- Date Picker ----
  function renderDatePickerModal() {
    const d = state.modalData;
    const horse = state.horses.find(function(h){return h.id===d.horseId;});
    const type = state.types.find(function(t){return t.id===d.typeId;});
    return modalWrap(
      '<div class="flex items-center justify-between mb-4"><div><div class="font-bold text-pe-darker">' + escHTML(horse?.barn_name||horse?.name) + '</div><div class="text-xs text-gray-500 flex items-center gap-1"><span class="badge ' + categoryColor(type?.category) + ' text-white">' + type?.category + '</span>' + escHTML(type?.name) + '</div></div><button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full"><i class="fas fa-times text-gray-400"></i></button></div>' +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Date</label><input type="date" id="modalDate" value="' + d.date + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label><input type="text" id="modalNotes" value="' + escHTML(d.notes||'') + '" placeholder="Optional notes..." class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div class="flex gap-2 pt-2"><button onclick="setTodayDate()" class="flex-1 bg-pe-green text-white py-3 rounded-xl text-sm font-semibold hover:bg-pe-green-dark transition-colors"><i class="fas fa-calendar-check mr-1"></i>Today</button><button onclick="saveDatePicker()" class="flex-1 bg-pe-slate text-white py-3 rounded-xl text-sm font-semibold hover:bg-pe-dark transition-colors"><i class="fas fa-save mr-1"></i>Save</button></div>' +
        (d.date ? '<button onclick="clearDate()" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors"><i class="fas fa-trash-alt mr-1"></i>Clear Date</button>' : '') +
      '</div>'
    );
  }

  // ---- Add Horse ----
  function renderAddHorseModal() {
    return modalWrap(
      modalHeader('Add New Horse') +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Registered Name *</label><input type="text" id="addHorseName" placeholder="e.g. HH Kingdom PS" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Barn Name</label><input type="text" id="addHorseBarn" placeholder="e.g. Buddy" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Owner *</label><select id="addHorseOwner" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none"><option value="">Select owner...</option>' + state.owners.map(function(o){return '<option value="'+o.id+'">'+escHTML(o.name)+(o.stable_name?' ('+escHTML(o.stable_name)+')':'')+'</option>';}).join('') + '</select>' +
          '<button onclick="toggleNewOwner()" class="text-xs text-pe-green mt-1 hover:underline"><i class="fas fa-plus-circle mr-0.5"></i>Add new owner</button>' +
          '<div id="newOwnerRow" class="hidden mt-2 space-y-2"><input type="text" id="addNewOwnerName" placeholder="New owner name" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />' +
          '<select id="addNewOwnerStable" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none"><option value="">Assign to stable...</option>' + state.stables.map(function(s){return '<option value="'+s.id+'">'+escHTML(s.name)+'</option>';}).join('') + '</select></div>' +
        '</div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Assigned Vet</label><select id="addHorseVet" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none"><option value="">Select vet...</option>' + state.vets.map(function(v){return '<option value="'+v.id+'">'+escHTML(v.name)+'</option>';}).join('') + '</select></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label><textarea id="addHorseNotes" placeholder="Optional notes..." rows="2" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none"></textarea></div>' +
        '<button onclick="saveNewHorse()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors mt-2"><i class="fas fa-plus mr-1"></i>Add Horse</button>' +
      '</div>'
    );
  }

  // ---- Edit Horse ----
  function renderEditHorseModal() {
    const d = state.modalData;
    if (!d) return '';
    return modalWrap(
      modalHeader('Edit Horse') +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Registered Name *</label><input type="text" id="editHorseName" value="' + escHTML(d.name) + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Barn Name</label><input type="text" id="editHorseBarn" value="' + escHTML(d.barn_name||'') + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Owner *</label><select id="editHorseOwner" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none">' + state.owners.map(function(o){return '<option value="'+o.id+'"'+(o.id===d.owner_id?' selected':'')+'>'+escHTML(o.name)+'</option>';}).join('') + '</select></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Assigned Vet</label><select id="editHorseVet" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none"><option value="">No vet assigned</option>' + state.vets.map(function(v){return '<option value="'+v.id+'"'+(v.id===d.vet_id?' selected':'')+'>'+escHTML(v.name)+'</option>';}).join('') + '</select></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label><textarea id="editHorseNotes" rows="3" placeholder="Optional notes..." class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none">' + escHTML(d.notes||'') + '</textarea></div>' +
        '<button onclick="saveEditHorse()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors"><i class="fas fa-save mr-1"></i>Save Changes</button>' +
        '<div class="pt-2 border-t border-gray-100">' +
          '<button onclick="deactivateHorse(' + d.id + ')" class="w-full text-amber-600 text-xs py-2 hover:bg-amber-50 rounded-lg transition-colors flex items-center justify-center gap-1"><i class="fas fa-eye-slash"></i>Deactivate Horse</button>' +
          '<button onclick="deleteHorse(' + d.id + ')" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-1"><i class="fas fa-trash-alt"></i>Delete Horse Permanently</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ---- Edit Owner ----
  function renderEditOwnerModal() {
    const d = state.modalData;
    if (!d) return '';
    return modalWrap(
      modalHeader('Edit Owner') +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Owner Name *</label><input type="text" id="editOwnerName" value="' + escHTML(d.name) + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Stable</label><select id="editOwnerStable" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none"><option value="">No stable</option>' + state.stables.map(function(s){return '<option value="'+s.id+'"'+(s.id===d.stable_id?' selected':'')+'>'+escHTML(s.name)+'</option>';}).join('') + '</select></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Contact (phone/email)</label><input type="text" id="editOwnerContact" value="' + escHTML(d.contact||'') + '" placeholder="e.g. 555-1234" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label><textarea id="editOwnerNotes" rows="2" placeholder="Optional notes..." class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none">' + escHTML(d.notes||'') + '</textarea></div>' +
        '<button onclick="saveEditOwner()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors"><i class="fas fa-save mr-1"></i>Save Changes</button>' +
        '<div class="pt-2 border-t border-gray-100"><button onclick="deleteOwner(' + d.id + ')" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-1"><i class="fas fa-trash-alt"></i>Delete Owner</button><div class="text-[10px] text-gray-400 text-center mt-1">Owner can only be deleted if they have no horses.</div></div>' +
      '</div>'
    );
  }

  // ---- Edit Stable ----
  function renderEditStableModal() {
    const d = state.modalData;
    if (!d) return '';
    return modalWrap(
      modalHeader('Edit Stable') +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Stable Name *</label><input type="text" id="editStableName" value="' + escHTML(d.name) + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Contact</label><input type="text" id="editStableContact" value="' + escHTML(d.contact||'') + '" placeholder="Phone or email" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Address</label><input type="text" id="editStableAddress" value="' + escHTML(d.address||'') + '" placeholder="Street address" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label><textarea id="editStableNotes" rows="2" placeholder="Optional notes..." class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none">' + escHTML(d.notes||'') + '</textarea></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Login PIN</label><input type="text" id="editStablePin" value="' + escHTML(d.pin||'') + '" placeholder="4-digit PIN" maxlength="10" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<button onclick="saveEditStable()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors"><i class="fas fa-save mr-1"></i>Save Changes</button>' +
        '<div class="pt-2 border-t border-gray-100"><button onclick="deleteStable(' + d.id + ')" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-1"><i class="fas fa-trash-alt"></i>Delete Stable</button><div class="text-[10px] text-gray-400 text-center mt-1">Stable can only be deleted if no owners are linked to it.</div></div>' +
      '</div>'
    );
  }

  // ---- Edit Vet ----
  function renderEditVetModal() {
    const d = state.modalData;
    if (!d) return '';
    return modalWrap(
      modalHeader('Edit Veterinarian') +
      '<div class="space-y-3">' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Name *</label><input type="text" id="editVetName" value="' + escHTML(d.name) + '" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Email</label><input type="email" id="editVetEmail" value="' + escHTML(d.email||'') + '" placeholder="vet@example.com" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Phone</label><input type="tel" id="editVetPhone" value="' + escHTML(d.phone||'') + '" placeholder="555-1234" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<div><label class="text-xs font-semibold text-gray-600 mb-1 block">Login PIN</label><input type="text" id="editVetPin" value="' + escHTML(d.pin||'') + '" placeholder="4-digit PIN" maxlength="10" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" /></div>' +
        '<button onclick="saveEditVet()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors"><i class="fas fa-save mr-1"></i>Save Changes</button>' +
      '</div>'
    );
  }

  // ---- Horse Detail ----
  function renderHorseDetailModal() {
    const horse = state.selectedHorse;
    if (!horse) return '';
    const groupedTreatments = {};
    (horse.treatments || []).forEach(function(t) {
      if (!groupedTreatments[t.category]) groupedTreatments[t.category] = [];
      groupedTreatments[t.category].push(t);
    });
    const categoryLabels = { vaccine: 'Vaccines', test: 'Tests', maintenance: 'Maintenance', injection: 'Joint Injections' };

    let html = '<div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">' +
      '<div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto p-5 pb-8">' +
        '<div class="flex items-center justify-between mb-4"><div>' +
          '<div class="font-bold text-pe-darker text-lg">' + escHTML(horse.barn_name||horse.name) + '</div>' +
          '<div class="text-xs text-gray-500">' + escHTML(horse.name) + '</div>' +
          '<div class="text-xs text-gray-400 mt-0.5"><i class="fas fa-user-circle mr-1"></i>' + escHTML(horse.owner_name) + (horse.stable_name ? ' <span class="text-pe-accent">(' + escHTML(horse.stable_name) + ')</span>' : '') + '</div>' +
          (horse.vet_name ? '<div class="text-xs text-gray-400"><i class="fas fa-user-md mr-1"></i>' + escHTML(horse.vet_name) + '</div>' : '') +
        '</div><div class="flex items-center gap-1">' +
          (isVet() ? '<button onclick="openEditHorseModal(' + horse.id + ')" class="p-2 hover:bg-gray-100 rounded-full text-pe-accent" title="Edit Horse"><i class="fas fa-pen text-sm"></i></button>' : '') +
          '<button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full"><i class="fas fa-times text-gray-400"></i></button>' +
        '</div></div>';

    if (horse.notes) {
      html += '<div class="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-4 text-xs text-amber-800"><i class="fas fa-sticky-note mr-1"></i>' + escHTML(horse.notes) + '</div>';
    }

    Object.keys(categoryLabels).forEach(function(cat) {
      const treats = groupedTreatments[cat] || [];
      const allTypesForCat = state.types.filter(function(t){return t.category===cat;});
      if (allTypesForCat.length === 0) return;

      html += '<div class="mb-4"><div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5"><i class="fas ' + categoryIcon(cat) + '"></i>' + categoryLabels[cat] + '</div><div class="space-y-1">';

      const treatsMap = {};
      treats.forEach(function(t){treatsMap[t.treatment_type_id]=t;});

      allTypesForCat.forEach(function(tt) {
        const t = treatsMap[tt.id];
        const dateStr = t ? t.treatment_date : null;
        const display = formatDate(dateStr);
        const cls = dateStr ? dateClass(dateStr) : 'text-gray-400';
        const clickable = isVet();
        html += '<div class="flex items-center justify-between px-3 py-2 rounded-lg ' + categoryBgLight(cat) + ' border' + (clickable ? ' cursor-pointer' : '') + '"' +
          (clickable ? ' onclick="openDatePicker(' + horse.id + ', ' + tt.id + ', &apos;' + (dateStr||'') + '&apos;, &apos;' + ((t?.notes||'').replace(/'/g,'')) + '&apos;)"' : '') + '>' +
          '<span class="text-xs font-medium text-gray-700">' + escHTML(tt.name) + '</span>' +
          '<div class="text-right"><span class="text-xs ' + cls + '">' + (display||'&mdash;') + '</span>' +
          (t?.notes ? '<div class="text-[9px] text-gray-400 truncate max-w-[100px]">' + escHTML(t.notes) + '</div>' : '') +
          '</div></div>';
      });

      html += '</div></div>';
    });

    html += '</div></div>';
    return html;
  }

  // ---- Settings ----
  function renderSettingsModal() {
    let html = modalWrap(
      '<div class="flex items-center justify-between mb-4"><div class="font-bold text-pe-darker text-lg">Settings</div><button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full"><i class="fas fa-times text-gray-400"></i></button></div>' +
      '<div class="space-y-4">'
    );

    // Stables section (vet only)
    if (isVet()) {
      html = html.replace('</div></div></div>', ''); // Remove closings to continue building
      // We'll rebuild differently - let me just build the inner content
    }

    // Build inner content
    let inner = '<div class="flex items-center justify-between mb-4"><div class="font-bold text-pe-darker text-lg">Settings</div><button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full"><i class="fas fa-times text-gray-400"></i></button></div>';
    inner += '<div class="space-y-4">';

    // Stables section (vet only)
    if (isVet()) {
      inner += '<div><div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2"><i class="fas fa-warehouse mr-1"></i>Stables</div><div class="space-y-1">';
      state.stables.forEach(function(s) {
        inner += '<div class="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 active:bg-gray-200 transition-colors" onclick="openEditStableModal(' + s.id + ')">' +
          '<div><div class="text-sm font-medium">' + escHTML(s.name) + '</div>' +
          (s.contact ? '<div class="text-[10px] text-gray-400">' + escHTML(s.contact) + '</div>' : '') +
          (s.address ? '<div class="text-[10px] text-gray-400">' + escHTML(s.address) + '</div>' : '') +
          '</div><div class="flex items-center gap-2"><span class="text-[10px] text-gray-400">' + (s.horse_count||0) + ' horses</span><i class="fas fa-chevron-right text-gray-300 text-xs"></i></div></div>';
      });
      inner += '</div>';
      inner += '<div class="mt-2 flex gap-2"><input type="text" id="newStableInput" placeholder="New stable name" class="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:border-pe-green outline-none" /><button onclick="addStableFromSettings()" class="bg-pe-green text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-pe-green-dark">Add</button></div></div>';

      // Vets section
      inner += '<div><div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2"><i class="fas fa-user-md mr-1"></i>Veterinarians</div><div class="space-y-1">';
      state.vets.forEach(function(v) {
        inner += '<div class="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 active:bg-gray-200 transition-colors" onclick="openEditVetModal(' + v.id + ')">' +
          '<div><div class="text-sm font-medium">' + escHTML(v.name) + '</div>' +
          (v.email ? '<div class="text-[10px] text-gray-400">' + escHTML(v.email) + '</div>' : '') +
          (v.phone ? '<div class="text-[10px] text-gray-400">' + escHTML(v.phone) + '</div>' : '') +
          '</div><div class="flex items-center gap-2"><span class="text-[10px] text-gray-400">' + (v.horse_count||0) + ' horses</span><i class="fas fa-chevron-right text-gray-300 text-xs"></i></div></div>';
      });
      inner += '</div>';
      inner += '<div class="mt-2 flex gap-2"><input type="text" id="newVetInput" placeholder="New vet name" class="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:border-pe-green outline-none" /><button onclick="addVetFromSettings()" class="bg-pe-green text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-pe-green-dark">Add</button></div></div>';
    }

    // Owners section
    inner += '<div><div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2"><i class="fas fa-user-circle mr-1"></i>Owners</div><div class="space-y-1">';
    state.owners.forEach(function(o) {
      inner += '<div class="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg' + (isVet() ? ' cursor-pointer hover:bg-gray-100 active:bg-gray-200' : '') + ' transition-colors"' + (isVet() ? ' onclick="openEditOwnerModal(' + o.id + ')"' : '') + '>' +
        '<div><div class="text-sm font-medium">' + escHTML(o.name) + '</div>' +
        (o.stable_name ? '<div class="text-[10px] text-pe-accent"><i class="fas fa-warehouse mr-0.5"></i>' + escHTML(o.stable_name) + '</div>' : '') +
        (o.contact ? '<div class="text-[10px] text-gray-400">' + escHTML(o.contact) + '</div>' : '') +
        '</div><div class="flex items-center gap-2"><span class="text-[10px] text-gray-400">' + (o.horse_count||0) + ' horse' + ((o.horse_count||0)!==1?'s':'') + '</span>' + (isVet() ? '<i class="fas fa-chevron-right text-gray-300 text-xs"></i>' : '') + '</div></div>';
    });
    inner += '</div>';
    if (isVet()) {
      inner += '<div class="mt-2 flex gap-2"><input type="text" id="newOwnerInput" placeholder="New owner name" class="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:border-pe-green outline-none" /><button onclick="addOwnerFromSettings()" class="bg-pe-green text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-pe-green-dark">Add</button></div>';
    }
    inner += '</div>';

    // Treatment types (vet only can add)
    if (isVet()) {
      inner += '<div><div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2"><i class="fas fa-syringe mr-1"></i>Treatment Types</div><div class="space-y-1">';
      state.types.forEach(function(t) {
        inner += '<div class="flex items-center justify-between px-3 py-1.5 rounded-lg" style="background:' + t.color + '10;border-left:3px solid ' + t.color + '"><span class="text-xs font-medium">' + escHTML(t.name) + '</span><span class="badge" style="background:' + t.color + ';color:white;">' + t.category + '</span></div>';
      });
      inner += '</div>';
      inner += '<div class="mt-2 grid grid-cols-5 gap-1"><input type="text" id="newTypeName" placeholder="Name" class="col-span-2 px-2 py-2 border-2 border-gray-200 rounded-lg text-xs focus:border-pe-green outline-none" /><select id="newTypeCat" class="col-span-2 px-2 py-2 border-2 border-gray-200 rounded-lg text-xs focus:border-pe-green outline-none"><option value="vaccine">Vaccine</option><option value="test">Test</option><option value="maintenance">Maint.</option><option value="injection">Injection</option></select><button onclick="addTreatmentType()" class="bg-pe-green text-white rounded-lg text-xs font-semibold hover:bg-pe-green-dark"><i class="fas fa-plus"></i></button></div></div>';
    }

    // Legend
    inner += '<div class="pt-2 border-t text-center"><div class="text-[10px] text-gray-400">Paddock Equine Veterinary Services</div><div class="flex justify-center gap-3 mt-2"><span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span>&lt;90d</span><span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-amber-500 inline-block"></span>&gt;270d</span><span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-red-500 inline-block"></span>&gt;365d</span></div></div>';

    inner += '</div>';

    return modalWrap(inner);
  }

  // ==================== EVENT HANDLERS ====================
  let searchTimeout;
  function debounceSearch(val) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function() { state.search = val; loadGrid(); }, 300);
  }
  function setCategory(cat) { state.categoryFilter = cat; loadGrid(); }
  function setOwnerFilter(owner) { state.ownerFilter = owner; loadGrid(); }
  function setStableFilter(id) { state.stableFilter = id; loadGrid(); }
  function setSort(sort) { state.sort = sort; loadGrid(); }

  function closeModal() { state.modal = null; state.modalData = null; state.selectedHorse = null; render(); }
  function closeModalBg(e) { if (e.target === e.currentTarget) closeModal(); }

  // Date picker
  function openDatePicker(horseId, typeId, date, notes) {
    state.modal = 'datePicker';
    state.modalData = { horseId: horseId, typeId: typeId, date: date || '', notes: notes || '' };
    render();
  }
  function setTodayDate() { document.getElementById('modalDate').value = new Date().toISOString().split('T')[0]; }
  async function saveDatePicker() {
    const d = state.modalData;
    await api.put('/api/treatments', { horse_id: d.horseId, treatment_type_id: d.typeId, treatment_date: document.getElementById('modalDate').value || null, notes: document.getElementById('modalNotes').value || null });
    showToast('Date saved!');
    closeModal();
    loadGrid();
  }
  async function clearDate() {
    const d = state.modalData;
    const ht = state.treatments[d.horseId];
    if (ht && ht[d.typeId]) {
      await api.del('/api/treatments/' + ht[d.typeId].id);
      showToast('Date cleared', 'info');
      closeModal();
      loadGrid();
    }
  }

  // Add horse
  function openAddHorseModal() { state.modal = 'addHorse'; render(); }
  function toggleNewOwner() { document.getElementById('newOwnerRow').classList.toggle('hidden'); }
  async function saveNewHorse() {
    const name = document.getElementById('addHorseName').value.trim();
    const barn = document.getElementById('addHorseBarn').value.trim();
    let ownerId = document.getElementById('addHorseOwner').value;
    const vetId = document.getElementById('addHorseVet').value;
    const notes = document.getElementById('addHorseNotes').value.trim();
    const newOwnerName = document.getElementById('addNewOwnerName')?.value?.trim();
    const newOwnerStable = document.getElementById('addNewOwnerStable')?.value;
    if (!name) { showToast('Name is required', 'error'); return; }
    if (newOwnerName) {
      const or = await api.post('/api/owners', { name: newOwnerName, stable_id: newOwnerStable ? parseInt(newOwnerStable) : null });
      if (or.error) { showToast(or.error, 'error'); return; }
      ownerId = or.id;
      await loadOwners();
    }
    if (!ownerId) { showToast('Please select an owner', 'error'); return; }
    const result = await api.post('/api/horses', { name: name, barn_name: barn, owner_id: parseInt(ownerId), notes: notes, vet_id: vetId ? parseInt(vetId) : null });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Horse added!');
    closeModal();
    loadGrid();
  }

  // Horse detail
  async function openHorseDetail(id) {
    const horse = await api.get('/api/horses/' + id);
    state.selectedHorse = horse;
    state.modal = 'horseDetail';
    render();
  }
  function openEditHorseModal(id) {
    const horse = state.selectedHorse || state.horses.find(function(h){return h.id===id;});
    if (!horse) return;
    state.modal = 'editHorse';
    state.modalData = { id: horse.id, name: horse.name, barn_name: horse.barn_name, owner_id: horse.owner_id, notes: horse.notes, vet_id: horse.vet_id };
    render();
  }
  async function saveEditHorse() {
    const d = state.modalData;
    const name = document.getElementById('editHorseName').value.trim();
    const barn_name = document.getElementById('editHorseBarn').value.trim();
    const owner_id = parseInt(document.getElementById('editHorseOwner').value);
    const vet_id = document.getElementById('editHorseVet').value ? parseInt(document.getElementById('editHorseVet').value) : null;
    const notes = document.getElementById('editHorseNotes').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    await api.put('/api/horses/' + d.id, { name: name, barn_name: barn_name, owner_id: owner_id, notes: notes, vet_id: vet_id });
    showToast('Horse updated!');
    closeModal();
    await loadGrid();
  }
  async function deactivateHorse(id) {
    if (!confirm('Deactivate this horse? It will be hidden from the grid.')) return;
    await api.put('/api/horses/' + id, { active: 0 });
    showToast('Horse deactivated', 'info');
    closeModal();
    await loadGrid();
  }
  async function deleteHorse(id) {
    if (!confirm('Permanently delete this horse and all treatment records?')) return;
    await api.del('/api/horses/' + id);
    showToast('Horse deleted', 'info');
    closeModal();
    await loadGrid();
  }

  // Owners
  function openEditOwnerModal(id) {
    const owner = state.owners.find(function(o){return o.id===id;});
    if (!owner) return;
    state.modal = 'editOwner';
    state.modalData = { id: owner.id, name: owner.name, contact: owner.contact, notes: owner.notes, stable_id: owner.stable_id };
    render();
  }
  async function saveEditOwner() {
    const d = state.modalData;
    const name = document.getElementById('editOwnerName').value.trim();
    const stableId = document.getElementById('editOwnerStable').value;
    const contact = document.getElementById('editOwnerContact').value.trim();
    const notes = document.getElementById('editOwnerNotes').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    await api.put('/api/owners/' + d.id, { name: name, contact: contact, notes: notes, stable_id: stableId ? parseInt(stableId) : null });
    showToast('Owner updated!');
    await loadOwners();
    state.modal = 'settings'; state.modalData = null;
    await loadGrid(); render();
  }
  async function deleteOwner(id) {
    const oh = state.horses.filter(function(h){return h.owner_id===id;});
    if (oh.length > 0) { showToast('Cannot delete: owner has ' + oh.length + ' horse(s)', 'error'); return; }
    if (!confirm('Delete this owner permanently?')) return;
    await api.del('/api/owners/' + id);
    showToast('Owner deleted', 'info');
    await loadOwners();
    state.modal = 'settings'; state.modalData = null;
    await loadGrid(); render();
  }
  async function addOwnerFromSettings() {
    const name = document.getElementById('newOwnerInput').value.trim();
    if (!name) return;
    const result = await api.post('/api/owners', { name: name });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Owner added!');
    await loadOwners();
    state.modal = 'settings'; render();
  }

  // Stables
  function openEditStableModal(id) {
    const s = state.stables.find(function(x){return x.id===id;});
    if (!s) return;
    state.modal = 'editStable';
    state.modalData = { id: s.id, name: s.name, contact: s.contact, address: s.address, notes: s.notes, pin: s.pin };
    render();
  }
  async function saveEditStable() {
    const d = state.modalData;
    const name = document.getElementById('editStableName').value.trim();
    const contact = document.getElementById('editStableContact').value.trim();
    const address = document.getElementById('editStableAddress').value.trim();
    const notes = document.getElementById('editStableNotes').value.trim();
    const pin = document.getElementById('editStablePin').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    await api.put('/api/stables/' + d.id, { name: name, contact: contact, address: address, notes: notes, pin: pin || undefined });
    showToast('Stable updated!');
    await loadStables();
    state.modal = 'settings'; state.modalData = null; render();
  }
  async function deleteStable(id) {
    if (!confirm('Delete this stable permanently?')) return;
    const result = await api.del('/api/stables/' + id);
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Stable deleted', 'info');
    await loadStables();
    state.modal = 'settings'; state.modalData = null; render();
  }
  async function addStableFromSettings() {
    const name = document.getElementById('newStableInput').value.trim();
    if (!name) return;
    const result = await api.post('/api/stables', { name: name });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Stable added!');
    await loadStables();
    state.modal = 'settings'; render();
  }

  // Vets
  function openEditVetModal(id) {
    const v = state.vets.find(function(x){return x.id===id;});
    if (!v) return;
    state.modal = 'editVet';
    state.modalData = { id: v.id, name: v.name, email: v.email, phone: v.phone, pin: v.pin };
    render();
  }
  async function saveEditVet() {
    const d = state.modalData;
    const name = document.getElementById('editVetName').value.trim();
    const email = document.getElementById('editVetEmail').value.trim();
    const phone = document.getElementById('editVetPhone').value.trim();
    const pin = document.getElementById('editVetPin').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    await api.put('/api/vets/' + d.id, { name: name, email: email, phone: phone, pin: pin || undefined });
    showToast('Vet updated!');
    await loadVets();
    state.modal = 'settings'; state.modalData = null; render();
  }
  async function addVetFromSettings() {
    const name = document.getElementById('newVetInput').value.trim();
    if (!name) return;
    const result = await api.post('/api/vets', { name: name });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Vet added!');
    await loadVets();
    state.modal = 'settings'; render();
  }

  // Treatment types
  async function addTreatmentType() {
    const name = document.getElementById('newTypeName').value.trim();
    const category = document.getElementById('newTypeCat').value;
    if (!name) return;
    const result = await api.post('/api/treatment-types', { name: name, category: category, sort_order: state.types.length + 1 });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Treatment type added!');
    await loadGrid();
    state.modal = 'settings'; render();
  }

  // Settings
  function openSettingsModal() { state.modal = 'settings'; render(); }

  // ==================== INIT ====================
  init();
  </script>
</body>
</html>`;
}

export default app
