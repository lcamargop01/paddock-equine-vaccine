import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ==================== OWNERS API ====================

app.get('/api/owners', async (c) => {
  const db = c.env.DB
  const owners = await db.prepare(`
    SELECT o.*, COUNT(h.id) as horse_count
    FROM owners o
    LEFT JOIN horses h ON h.owner_id = o.id AND h.active = 1
    GROUP BY o.id
    ORDER BY o.name
  `).all()
  return c.json(owners.results)
})

app.post('/api/owners', async (c) => {
  const db = c.env.DB
  const { name, contact, notes } = await c.req.json()
  if (!name) return c.json({ error: 'Name is required' }, 400)
  try {
    const result = await db.prepare('INSERT INTO owners (name, contact, notes) VALUES (?, ?, ?)')
      .bind(name, contact || null, notes || null).run()
    return c.json({ id: result.meta.last_row_id, name, contact, notes }, 201)
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
  
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400)
  
  params.push(id)
  await db.prepare(`UPDATE owners SET ${fields.join(', ')} WHERE id=?`).bind(...params).run()
  return c.json({ success: true })
})

app.delete('/api/owners/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  // Check if owner has horses
  const count = await db.prepare('SELECT COUNT(*) as cnt FROM horses WHERE owner_id=? AND active=1').bind(id).first() as any
  if (count?.cnt > 0) {
    return c.json({ error: `Cannot delete: owner has ${count.cnt} active horse(s)` }, 400)
  }
  await db.prepare('DELETE FROM owners WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== HORSES API ====================

app.get('/api/horses', async (c) => {
  const db = c.env.DB
  const search = c.req.query('search') || ''
  const owner = c.req.query('owner') || ''
  const active = c.req.query('active') !== '0' ? 1 : 0
  const sort = c.req.query('sort') || 'name'

  let query = `
    SELECT h.*, o.name as owner_name
    FROM horses h
    JOIN owners o ON h.owner_id = o.id
    WHERE h.active = ?
  `
  const params: any[] = [active]

  if (search) {
    query += ` AND (h.name LIKE ? OR h.barn_name LIKE ? OR o.name LIKE ?)`
    const s = `%${search}%`
    params.push(s, s, s)
  }

  if (owner) {
    query += ` AND o.name = ?`
    params.push(owner)
  }

  const sortMap: Record<string, string> = {
    name: 'h.name ASC',
    barn_name: 'h.barn_name ASC',
    owner: 'o.name ASC, h.name ASC',
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
    SELECT h.*, o.name as owner_name
    FROM horses h JOIN owners o ON h.owner_id = o.id
    WHERE h.id = ?
  `).bind(id).first()
  if (!horse) return c.json({ error: 'Horse not found' }, 404)

  // Get all treatments for this horse
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
  const { name, barn_name, owner_id, notes } = await c.req.json()
  if (!name || !owner_id) return c.json({ error: 'Name and owner_id are required' }, 400)

  const result = await db.prepare(
    'INSERT INTO horses (name, barn_name, owner_id, notes) VALUES (?, ?, ?, ?)'
  ).bind(name, barn_name || null, owner_id, notes || null).run()

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

// Get all treatments for a horse
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

// Upsert treatment date (set or update a date for a specific horse + treatment type)
app.put('/api/treatments', async (c) => {
  const db = c.env.DB
  const { horse_id, treatment_type_id, treatment_date, notes } = await c.req.json()
  if (!horse_id || !treatment_type_id) {
    return c.json({ error: 'horse_id and treatment_type_id are required' }, 400)
  }

  // Upsert: insert or update
  await db.prepare(`
    INSERT INTO treatments (horse_id, treatment_type_id, treatment_date, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (horse_id, treatment_type_id)
    DO UPDATE SET treatment_date=excluded.treatment_date, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP
  `).bind(horse_id, treatment_type_id, treatment_date || null, notes || null).run()

  // Also update the horse's updated_at
  await db.prepare('UPDATE horses SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(horse_id).run()

  return c.json({ success: true })
})

// Clear a treatment date
app.delete('/api/treatments/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM treatments WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ==================== GRID VIEW API ====================
// Returns a spreadsheet-like view with all horses and their treatment dates

app.get('/api/grid', async (c) => {
  const db = c.env.DB
  const search = c.req.query('search') || ''
  const owner = c.req.query('owner') || ''
  const category = c.req.query('category') || ''
  const sort = c.req.query('sort') || 'owner'

  // Get treatment types
  let typesQuery = 'SELECT * FROM treatment_types'
  const typesParams: any[] = []
  if (category) {
    typesQuery += ' WHERE category = ?'
    typesParams.push(category)
  }
  typesQuery += ' ORDER BY sort_order'
  const types = await db.prepare(typesQuery).bind(...typesParams).all()

  // Get horses with filters
  let horsesQuery = `
    SELECT h.*, o.name as owner_name
    FROM horses h
    JOIN owners o ON h.owner_id = o.id
    WHERE h.active = 1
  `
  const horsesParams: any[] = []

  if (search) {
    horsesQuery += ` AND (h.name LIKE ? OR h.barn_name LIKE ? OR o.name LIKE ?)`
    const s = `%${search}%`
    horsesParams.push(s, s, s)
  }
  if (owner) {
    horsesQuery += ` AND o.name = ?`
    horsesParams.push(owner)
  }

  const sortMap: Record<string, string> = {
    name: 'h.name ASC',
    barn_name: 'h.barn_name ASC',
    owner: 'o.name ASC, h.name ASC',
    updated: 'h.updated_at DESC'
  }
  horsesQuery += ` ORDER BY ${sortMap[sort] || 'o.name ASC, h.name ASC'}`

  const horses = await db.prepare(horsesQuery).bind(...horsesParams).all()

  // Get all treatments
  const allTreatments = await db.prepare(`
    SELECT t.horse_id, t.treatment_type_id, t.treatment_date, t.notes, t.id
    FROM treatments t
    JOIN horses h ON t.horse_id = h.id
    WHERE h.active = 1
  `).all()

  // Build treatment map: { horseId: { typeId: { date, notes, id } } }
  const treatmentMap: Record<number, Record<number, any>> = {}
  for (const t of allTreatments.results as any[]) {
    if (!treatmentMap[t.horse_id]) treatmentMap[t.horse_id] = {}
    treatmentMap[t.horse_id][t.treatment_type_id] = {
      id: t.id,
      date: t.treatment_date,
      notes: t.notes
    }
  }

  return c.json({
    types: types.results,
    horses: horses.results,
    treatments: treatmentMap
  })
})

// ==================== BULK OPERATIONS ====================

// Batch update treatments (for quick date setting across multiple horses)
app.post('/api/treatments/batch', async (c) => {
  const db = c.env.DB
  const { updates } = await c.req.json()
  // updates: Array<{ horse_id, treatment_type_id, treatment_date, notes }>

  if (!Array.isArray(updates) || updates.length === 0) {
    return c.json({ error: 'Updates array is required' }, 400)
  }

  const stmts = updates.map((u: any) =>
    db.prepare(`
      INSERT INTO treatments (horse_id, treatment_type_id, treatment_date, notes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (horse_id, treatment_type_id)
      DO UPDATE SET treatment_date=excluded.treatment_date, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐴</text></svg>">
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
    * { font-family: 'Inter', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
    body { overscroll-behavior: none; }
    .grid-table { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .grid-table table { border-collapse: separate; border-spacing: 0; }
    .grid-table th, .grid-table td { white-space: nowrap; }
    .sticky-col { position: sticky; left: 0; z-index: 10; }
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
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <div id="app"></div>

  <script>
  // ==================== STATE ====================
  const state = {
    view: 'grid',
    horses: [],
    owners: [],
    types: [],
    treatments: {},
    search: '',
    ownerFilter: '',
    categoryFilter: '',
    sort: 'owner',
    loading: true,
    selectedHorse: null,
    modal: null,
  };

  // ==================== API ====================
  const api = {
    async get(url) {
      const r = await fetch(url);
      return r.json();
    },
    async post(url, data) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return r.json();
    },
    async put(url, data) {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return r.json();
    },
    async del(url) {
      const r = await fetch(url, { method: 'DELETE' });
      return r.json();
    }
  };

  // ==================== DATA LOADING ====================
  async function loadGrid() {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.ownerFilter) params.set('owner', state.ownerFilter);
    if (state.categoryFilter) params.set('category', state.categoryFilter);
    params.set('sort', state.sort);

    const data = await api.get('/api/grid?' + params.toString());
    state.types = data.types;
    state.horses = data.horses;
    state.treatments = data.treatments;
    state.loading = false;
    render();
  }

  async function loadOwners() {
    state.owners = await api.get('/api/owners');
  }

  async function init() {
    await Promise.all([loadGrid(), loadOwners()]);
    render();
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
    const now = new Date();
    return Math.floor((now - d) / (1000 * 60 * 60 * 24));
  }

  function dateClass(dateStr) {
    const days = daysSince(dateStr);
    if (days > 365) return 'date-old';
    if (days > 270) return 'text-amber-600 font-medium';
    if (days <= 90) return 'date-recent';
    return 'text-gray-700';
  }

  function categoryIcon(cat) {
    switch(cat) {
      case 'vaccine': return 'fa-syringe';
      case 'test': return 'fa-vial';
      case 'maintenance': return 'fa-tooth';
      case 'injection': return 'fa-crosshairs';
      default: return 'fa-circle';
    }
  }

  function categoryColor(cat) {
    switch(cat) {
      case 'vaccine': return 'bg-green-600';
      case 'test': return 'bg-blue-500';
      case 'maintenance': return 'bg-purple-500';
      case 'injection': return 'bg-amber-600';
      default: return 'bg-gray-500';
    }
  }

  function categoryBgLight(cat) {
    switch(cat) {
      case 'vaccine': return 'bg-green-50 border-green-200';
      case 'test': return 'bg-blue-50 border-blue-200';
      case 'maintenance': return 'bg-purple-50 border-purple-200';
      case 'injection': return 'bg-amber-50 border-amber-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  }

  function escHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function showToast(msg, type = 'success') {
    const colors = { success: 'bg-pe-green', error: 'bg-red-600', info: 'bg-pe-accent' };
    const el = document.createElement('div');
    el.className = \`toast fixed top-4 right-4 z-[200] \${colors[type]} text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium\`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ==================== RENDERING ====================
  function render() {
    const app = document.getElementById('app');
    app.innerHTML = renderHeader() + renderFilters() + renderContent() + (state.modal ? renderModal() : '');
    attachEventListeners();
  }

  function renderHeader() {
    return \`
    <header class="bg-pe-slate text-white shadow-lg sticky top-0 z-50">
      <div class="flex items-center justify-between px-3 py-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-pe-green rounded-full flex items-center justify-center">
            <i class="fas fa-horse-head text-white text-sm"></i>
          </div>
          <div>
            <div class="text-sm font-bold tracking-wider leading-tight">PADDOCK EQUINE</div>
            <div class="text-[9px] tracking-[0.2em] text-gray-300 uppercase">Veterinary Services</div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="openAddHorseModal()" class="bg-pe-green hover:bg-pe-green-dark text-white px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors">
            <i class="fas fa-plus"></i>
            <span class="hidden sm:inline">Add Horse</span>
          </button>
          <button onclick="openSettingsModal()" class="p-2 hover:bg-pe-dark rounded-lg transition-colors">
            <i class="fas fa-cog text-sm"></i>
          </button>
        </div>
      </div>
    </header>\`;
  }

  function renderFilters() {
    const categories = [
      { key: '', label: 'All', icon: 'fa-th' },
      { key: 'vaccine', label: 'Vaccines', icon: 'fa-syringe' },
      { key: 'test', label: 'Tests', icon: 'fa-vial' },
      { key: 'maintenance', label: 'Maint.', icon: 'fa-tooth' },
      { key: 'injection', label: 'Injections', icon: 'fa-crosshairs' },
    ];

    return \`
    <div class="bg-white shadow-sm border-b">
      <div class="px-3 py-2">
        <div class="relative">
          <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
          <input type="search" placeholder="Search horses, owners..." value="\${state.search}" 
            onInput="debounceSearch(this.value)"
            class="search-input w-full pl-9 pr-4 py-2.5 bg-gray-100 rounded-xl text-sm border-2 border-transparent focus:border-pe-green focus:bg-white outline-none transition-all" />
        </div>
      </div>
      
      <div class="flex gap-1 px-3 pb-2 overflow-x-auto">
        \${categories.map(cat => \`
          <button onclick="setCategory('\${cat.key}')" 
            class="category-pill flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all
              \${state.categoryFilter === cat.key ? 'bg-pe-slate text-white active' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
            <i class="fas \${cat.icon} text-[10px]"></i>
            \${cat.label}
          </button>
        \`).join('')}
      </div>

      <div class="flex items-center gap-2 px-3 pb-2">
        <select onchange="setOwnerFilter(this.value)" class="text-xs bg-gray-100 border-0 rounded-lg px-2.5 py-1.5 font-medium text-gray-700 outline-none focus:ring-2 focus:ring-pe-green min-h-[32px]">
          <option value="" \${!state.ownerFilter ? 'selected' : ''}>All Owners</option>
          \${state.owners.map(o => \`<option value="\${o.name}" \${state.ownerFilter === o.name ? 'selected' : ''}>\${o.name}</option>\`).join('')}
        </select>
        <select onchange="setSort(this.value)" class="text-xs bg-gray-100 border-0 rounded-lg px-2.5 py-1.5 font-medium text-gray-700 outline-none focus:ring-2 focus:ring-pe-green min-h-[32px]">
          <option value="owner" \${state.sort === 'owner' ? 'selected' : ''}>Sort: Owner</option>
          <option value="name" \${state.sort === 'name' ? 'selected' : ''}>Sort: Name</option>
          <option value="barn_name" \${state.sort === 'barn_name' ? 'selected' : ''}>Sort: Barn Name</option>
        </select>
        <span class="text-[10px] text-gray-400 ml-auto">\${state.horses.length} horses</span>
      </div>
    </div>\`;
  }

  function renderContent() {
    if (state.loading) {
      return '<div class="flex items-center justify-center p-12"><i class="fas fa-spinner fa-spin text-3xl text-pe-green"></i></div>';
    }

    if (state.horses.length === 0) {
      return '<div class="text-center p-12 text-gray-400"><i class="fas fa-horse text-4xl mb-3"></i><p class="text-sm">No horses found</p></div>';
    }

    const filteredTypes = state.types;
    
    return \`
    <div class="grid-table pb-20">
      <table class="w-full text-xs">
        <thead>
          <tr class="bg-pe-dark text-white">
            <th class="sticky-col bg-pe-dark px-2 py-2.5 text-left font-semibold min-w-[140px]">
              <div class="flex flex-col">
                <span>Horse</span>
                <span class="text-[9px] font-normal text-gray-300">Barn Name</span>
              </div>
            </th>
            \${filteredTypes.map(t => \`
              <th class="px-2 py-2.5 text-center font-medium">
                <div class="flex flex-col items-center gap-0.5">
                  <span class="badge \${categoryColor(t.category)} text-white">\${t.category.slice(0,3).toUpperCase()}</span>
                  <span class="text-[10px] leading-tight">\${t.name}</span>
                </div>
              </th>
            \`).join('')}
            <th class="px-2 py-2.5 text-center font-medium min-w-[60px]">
              <i class="fas fa-sticky-note text-xs"></i>
            </th>
          </tr>
        </thead>
        <tbody>
          \${renderRows(filteredTypes)}
        </tbody>
      </table>
    </div>\`;
  }

  function renderRows(types) {
    let currentOwner = '';
    let rows = '';

    state.horses.forEach((horse, idx) => {
      // Owner separator
      if (horse.owner_name !== currentOwner) {
        currentOwner = horse.owner_name;
        rows += \`
          <tr>
            <td colspan="\${types.length + 2}" class="bg-pe-slate/10 px-3 py-1.5 border-t-2 border-pe-slate/20">
              <span class="text-[11px] font-bold text-pe-slate uppercase tracking-wider">
                <i class="fas fa-user-circle mr-1"></i>\${currentOwner}
              </span>
            </td>
          </tr>\`;
      }

      const horseTreatments = state.treatments[horse.id] || {};
      const bgClass = idx % 2 === 0 ? 'bg-white' : 'bg-gray-50';

      rows += \`
        <tr class="horse-row \${bgClass} border-b border-gray-100">
          <td class="sticky-col \${bgClass} px-2 py-2 border-r border-gray-200">
            <div class="cursor-pointer" onclick="openHorseDetail(\${horse.id})">
              <div class="font-semibold text-pe-darker text-[11px] leading-tight">\${horse.barn_name || horse.name}</div>
              <div class="text-[9px] text-gray-400 truncate max-w-[130px]">\${horse.name}</div>
            </div>
          </td>
          \${types.map(t => {
            const treat = horseTreatments[t.id];
            const dateStr = treat ? treat.date : null;
            const display = formatDate(dateStr);
            const cls = dateStr ? dateClass(dateStr) : 'text-gray-300';
            const hasNotes = treat && treat.notes;
            return \`
              <td class="date-cell px-1 py-2 text-center border-r border-gray-100 relative" 
                  onclick="openDatePicker(\${horse.id}, \${t.id}, '\${dateStr || ''}', '\${(treat?.notes || '').replace(/'/g, "\\\\'")}')">
                <div class="text-[11px] \${cls}">\${display || '&mdash;'}</div>
                \${hasNotes ? '<div class="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-pe-green rounded-full"></div>' : ''}
              </td>\`;
          }).join('')}
          <td class="px-1 py-2 text-center">
            \${horse.notes ? '<i class="fas fa-sticky-note text-amber-500 text-[10px]" title="' + horse.notes.replace(/"/g, '&quot;') + '"></i>' : '<span class="text-gray-200">&mdash;</span>'}
          </td>
        </tr>\`;
    });

    return rows;
  }

  // ==================== MODALS ====================
  function renderModal() {
    if (state.modal === 'datePicker') return renderDatePickerModal();
    if (state.modal === 'addHorse') return renderAddHorseModal();
    if (state.modal === 'editHorse') return renderEditHorseModal();
    if (state.modal === 'horseDetail') return renderHorseDetailModal();
    if (state.modal === 'editOwner') return renderEditOwnerModal();
    if (state.modal === 'settings') return renderSettingsModal();
    return '';
  }

  function renderDatePickerModal() {
    const d = state.modalData;
    const horse = state.horses.find(h => h.id === d.horseId);
    const type = state.types.find(t => t.id === d.typeId);

    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="font-bold text-pe-darker">\${horse?.barn_name || horse?.name}</div>
            <div class="text-xs text-gray-500 flex items-center gap-1">
              <span class="badge \${categoryColor(type?.category)} text-white">\${type?.category}</span>
              \${type?.name}
            </div>
          </div>
          <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
            <i class="fas fa-times text-gray-400"></i>
          </button>
        </div>
        
        <div class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Date</label>
            <input type="date" id="modalDate" value="\${d.date}" 
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label>
            <input type="text" id="modalNotes" value="\${d.notes || ''}" placeholder="Optional notes..."
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          
          <div class="flex gap-2 pt-2">
            <button onclick="setTodayDate()" class="flex-1 bg-pe-green text-white py-3 rounded-xl text-sm font-semibold hover:bg-pe-green-dark transition-colors">
              <i class="fas fa-calendar-check mr-1"></i> Today
            </button>
            <button onclick="saveDatePicker()" class="flex-1 bg-pe-slate text-white py-3 rounded-xl text-sm font-semibold hover:bg-pe-dark transition-colors">
              <i class="fas fa-save mr-1"></i> Save
            </button>
          </div>
          
          \${d.date ? \`
          <button onclick="clearDate()" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors">
            <i class="fas fa-trash-alt mr-1"></i> Clear Date
          </button>\` : ''}
        </div>
      </div>
    </div>\`;
  }

  function renderAddHorseModal() {
    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div class="font-bold text-pe-darker text-lg">Add New Horse</div>
          <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
            <i class="fas fa-times text-gray-400"></i>
          </button>
        </div>
        
        <div class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Registered Name *</label>
            <input type="text" id="addHorseName" placeholder="e.g. HH Kingdom PS"
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Barn Name</label>
            <input type="text" id="addHorseBarn" placeholder="e.g. Buddy"
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Owner *</label>
            <select id="addHorseOwner" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none">
              <option value="">Select owner...</option>
              \${state.owners.map(o => \`<option value="\${o.id}">\${o.name}</option>\`).join('')}
            </select>
            <button onclick="toggleNewOwner()" class="text-xs text-pe-green mt-1 hover:underline">
              <i class="fas fa-plus-circle mr-0.5"></i> Add new owner
            </button>
            <div id="newOwnerRow" class="hidden mt-2">
              <input type="text" id="addNewOwnerName" placeholder="New owner name"
                class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
            </div>
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label>
            <textarea id="addHorseNotes" placeholder="Optional notes..." rows="2"
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none"></textarea>
          </div>
          
          <button onclick="saveNewHorse()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors mt-2">
            <i class="fas fa-plus mr-1"></i> Add Horse
          </button>
        </div>
      </div>
    </div>\`;
  }

  function renderEditHorseModal() {
    const d = state.modalData;
    if (!d) return '';

    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div class="font-bold text-pe-darker text-lg">Edit Horse</div>
          <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
            <i class="fas fa-times text-gray-400"></i>
          </button>
        </div>
        
        <div class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Registered Name *</label>
            <input type="text" id="editHorseName" value="\${escHTML(d.name)}" 
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Barn Name</label>
            <input type="text" id="editHorseBarn" value="\${escHTML(d.barn_name || '')}" 
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Owner *</label>
            <select id="editHorseOwner" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none">
              \${state.owners.map(o => \`<option value="\${o.id}" \${o.id === d.owner_id ? 'selected' : ''}>\${o.name}</option>\`).join('')}
            </select>
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label>
            <textarea id="editHorseNotes" rows="3" placeholder="Optional notes..."
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none">\${escHTML(d.notes || '')}</textarea>
          </div>
          
          <button onclick="saveEditHorse()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors">
            <i class="fas fa-save mr-1"></i> Save Changes
          </button>

          <div class="pt-2 border-t border-gray-100">
            <button onclick="deactivateHorse(\${d.id})" class="w-full text-amber-600 text-xs py-2 hover:bg-amber-50 rounded-lg transition-colors flex items-center justify-center gap-1">
              <i class="fas fa-eye-slash"></i> Deactivate Horse
            </button>
            <button onclick="deleteHorse(\${d.id})" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-1">
              <i class="fas fa-trash-alt"></i> Delete Horse Permanently
            </button>
          </div>
        </div>
      </div>
    </div>\`;
  }

  function renderEditOwnerModal() {
    const d = state.modalData;
    if (!d) return '';

    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div class="font-bold text-pe-darker text-lg">Edit Owner</div>
          <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
            <i class="fas fa-times text-gray-400"></i>
          </button>
        </div>
        
        <div class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Owner Name *</label>
            <input type="text" id="editOwnerName" value="\${escHTML(d.name)}" 
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Contact (phone/email)</label>
            <input type="text" id="editOwnerContact" value="\${escHTML(d.contact || '')}" placeholder="e.g. 555-1234 or email@example.com"
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none" />
          </div>
          <div>
            <label class="text-xs font-semibold text-gray-600 mb-1 block">Notes</label>
            <textarea id="editOwnerNotes" rows="2" placeholder="Optional notes..."
              class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:border-pe-green outline-none resize-none">\${escHTML(d.notes || '')}</textarea>
          </div>
          
          <button onclick="saveEditOwner()" class="w-full bg-pe-green text-white py-3 rounded-xl text-sm font-bold hover:bg-pe-green-dark transition-colors">
            <i class="fas fa-save mr-1"></i> Save Changes
          </button>

          <div class="pt-2 border-t border-gray-100">
            <button onclick="deleteOwner(\${d.id})" class="w-full text-red-500 text-xs py-2 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center gap-1">
              <i class="fas fa-trash-alt"></i> Delete Owner
            </button>
            <div class="text-[10px] text-gray-400 text-center mt-1">Owner can only be deleted if they have no horses.</div>
          </div>
        </div>
      </div>
    </div>\`;
  }

  function renderHorseDetailModal() {
    const horse = state.selectedHorse;
    if (!horse) return '';

    const groupedTreatments = {};
    (horse.treatments || []).forEach(t => {
      if (!groupedTreatments[t.category]) groupedTreatments[t.category] = [];
      groupedTreatments[t.category].push(t);
    });

    const categoryLabels = { vaccine: 'Vaccines', test: 'Tests', maintenance: 'Maintenance', injection: 'Joint Injections' };

    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="font-bold text-pe-darker text-lg">\${horse.barn_name || horse.name}</div>
            <div class="text-xs text-gray-500">\${horse.name}</div>
            <div class="text-xs text-gray-400 mt-0.5"><i class="fas fa-user-circle mr-1"></i>\${horse.owner_name}</div>
          </div>
          <div class="flex items-center gap-1">
            <button onclick="openEditHorseModal(\${horse.id})" class="p-2 hover:bg-gray-100 rounded-full text-pe-accent" title="Edit Horse">
              <i class="fas fa-pen text-sm"></i>
            </button>
            <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
              <i class="fas fa-times text-gray-400"></i>
            </button>
          </div>
        </div>

        \${horse.notes ? \`<div class="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-4 text-xs text-amber-800"><i class="fas fa-sticky-note mr-1"></i>\${horse.notes}</div>\` : ''}

        \${Object.keys(categoryLabels).map(cat => {
          const treats = groupedTreatments[cat] || [];
          if (treats.length === 0 && cat !== 'vaccine') {
            // Show all treatment types for the category
            const allTypesForCat = state.types.filter(t => t.category === cat);
            if (allTypesForCat.length === 0) return '';
            return \`
            <div class="mb-4">
              <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <i class="fas \${categoryIcon(cat)}"></i>\${categoryLabels[cat]}
              </div>
              <div class="space-y-1">
                \${allTypesForCat.map(t => \`
                  <div class="flex items-center justify-between px-3 py-2 rounded-lg \${categoryBgLight(cat)} border cursor-pointer"
                       onclick="openDatePicker(\${horse.id}, \${t.id}, '', '')">
                    <span class="text-xs font-medium text-gray-700">\${t.name}</span>
                    <span class="text-xs text-gray-400">&mdash;</span>
                  </div>
                \`).join('')}
              </div>
            </div>\`;
          }

          const allTypesForCat = state.types.filter(t => t.category === cat);
          const treatsMap = {};
          treats.forEach(t => treatsMap[t.treatment_type_id] = t);

          return \`
          <div class="mb-4">
            <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <i class="fas \${categoryIcon(cat)}"></i>\${categoryLabels[cat]}
            </div>
            <div class="space-y-1">
              \${allTypesForCat.map(tt => {
                const t = treatsMap[tt.id];
                const dateStr = t ? t.treatment_date : null;
                const display = formatDate(dateStr);
                const cls = dateStr ? dateClass(dateStr) : 'text-gray-400';
                return \`
                <div class="flex items-center justify-between px-3 py-2 rounded-lg \${categoryBgLight(cat)} border cursor-pointer"
                     onclick="openDatePicker(\${horse.id}, \${tt.id}, '\${dateStr || ''}', '\${(t?.notes || '').replace(/'/g, "\\\\'")}')">
                  <span class="text-xs font-medium text-gray-700">\${tt.name}</span>
                  <div class="text-right">
                    <span class="text-xs \${cls}">\${display || '&mdash;'}</span>
                    \${t?.notes ? '<div class="text-[9px] text-gray-400 truncate max-w-[100px]">' + t.notes + '</div>' : ''}
                  </div>
                </div>\`;
              }).join('')}
            </div>
          </div>\`;
        }).join('')}
      </div>
    </div>\`;
  }

  function renderSettingsModal() {
    return \`
    <div class="modal-overlay fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center" onclick="closeModalBg(event)">
      <div class="modal-content bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5 pb-8">
        <div class="flex items-center justify-between mb-4">
          <div class="font-bold text-pe-darker text-lg">Settings</div>
          <button onclick="closeModal()" class="p-2 hover:bg-gray-100 rounded-full">
            <i class="fas fa-times text-gray-400"></i>
          </button>
        </div>
        
        <div class="space-y-4">
          <div>
            <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Owners</div>
            <div class="space-y-1">
              \${state.owners.map(o => \`
                <div class="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 active:bg-gray-200 transition-colors" onclick="openEditOwnerModal(\${o.id})">
                  <div>
                    <div class="text-sm font-medium">\${o.name}</div>
                    \${o.contact ? '<div class="text-[10px] text-gray-400">' + escHTML(o.contact) + '</div>' : ''}
                    \${o.notes ? '<div class="text-[10px] text-gray-400 italic">' + escHTML(o.notes) + '</div>' : ''}
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-[10px] text-gray-400">\${o.horse_count || 0} horse\${(o.horse_count || 0) !== 1 ? 's' : ''}</span>
                    <i class="fas fa-chevron-right text-gray-300 text-xs"></i>
                  </div>
                </div>
              \`).join('')}
            </div>
            <div class="mt-2 flex gap-2">
              <input type="text" id="newOwnerInput" placeholder="New owner name" 
                class="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:border-pe-green outline-none" />
              <button onclick="addOwnerFromSettings()" class="bg-pe-green text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-pe-green-dark">
                Add
              </button>
            </div>
          </div>

          <div>
            <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Treatment Types</div>
            <div class="space-y-1">
              \${state.types.map(t => \`
                <div class="flex items-center justify-between px-3 py-1.5 rounded-lg" style="background: \${t.color}10; border-left: 3px solid \${t.color}">
                  <span class="text-xs font-medium">\${t.name}</span>
                  <span class="badge" style="background: \${t.color}; color: white;">\${t.category}</span>
                </div>
              \`).join('')}
            </div>
            <div class="mt-2 grid grid-cols-5 gap-1">
              <input type="text" id="newTypeName" placeholder="Name" class="col-span-2 px-2 py-2 border-2 border-gray-200 rounded-lg text-xs focus:border-pe-green outline-none" />
              <select id="newTypeCat" class="col-span-2 px-2 py-2 border-2 border-gray-200 rounded-lg text-xs focus:border-pe-green outline-none">
                <option value="vaccine">Vaccine</option>
                <option value="test">Test</option>
                <option value="maintenance">Maint.</option>
                <option value="injection">Injection</option>
              </select>
              <button onclick="addTreatmentType()" class="bg-pe-green text-white rounded-lg text-xs font-semibold hover:bg-pe-green-dark">
                <i class="fas fa-plus"></i>
              </button>
            </div>
          </div>

          <div class="pt-2 border-t text-center">
            <div class="text-[10px] text-gray-400">Paddock Equine Veterinary Services</div>
            <div class="flex justify-center gap-3 mt-2">
              <span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span> &lt;90 days</span>
              <span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-amber-500 inline-block"></span> &gt;270 days</span>
              <span class="flex items-center gap-1 text-[10px]"><span class="w-2 h-2 rounded-full bg-red-500 inline-block"></span> &gt;365 days</span>
            </div>
          </div>
        </div>
      </div>
    </div>\`;
  }

  // ==================== EVENT HANDLERS ====================
  let searchTimeout;
  function debounceSearch(val) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = val;
      loadGrid();
    }, 300);
  }

  function setCategory(cat) {
    state.categoryFilter = cat;
    loadGrid();
  }

  function setOwnerFilter(owner) {
    state.ownerFilter = owner;
    loadGrid();
  }

  function setSort(sort) {
    state.sort = sort;
    loadGrid();
  }

  function closeModal() {
    state.modal = null;
    state.modalData = null;
    state.selectedHorse = null;
    render();
  }

  function closeModalBg(e) {
    if (e.target === e.currentTarget) closeModal();
  }

  // Date picker
  function openDatePicker(horseId, typeId, date, notes) {
    state.modal = 'datePicker';
    state.modalData = { horseId, typeId, date: date || '', notes: notes || '' };
    render();
  }

  function setTodayDate() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('modalDate').value = today;
  }

  async function saveDatePicker() {
    const d = state.modalData;
    const date = document.getElementById('modalDate').value;
    const notes = document.getElementById('modalNotes').value;
    
    await api.put('/api/treatments', {
      horse_id: d.horseId,
      treatment_type_id: d.typeId,
      treatment_date: date || null,
      notes: notes || null
    });
    
    showToast('Date saved!');
    closeModal();
    loadGrid();
  }

  async function clearDate() {
    const d = state.modalData;
    const horseTreats = state.treatments[d.horseId];
    if (horseTreats && horseTreats[d.typeId]) {
      await api.del('/api/treatments/' + horseTreats[d.typeId].id);
      showToast('Date cleared', 'info');
      closeModal();
      loadGrid();
    }
  }

  // Add horse
  function openAddHorseModal() {
    state.modal = 'addHorse';
    render();
  }

  function toggleNewOwner() {
    const row = document.getElementById('newOwnerRow');
    row.classList.toggle('hidden');
  }

  async function saveNewHorse() {
    const name = document.getElementById('addHorseName').value.trim();
    const barn = document.getElementById('addHorseBarn').value.trim();
    let ownerId = document.getElementById('addHorseOwner').value;
    const notes = document.getElementById('addHorseNotes').value.trim();
    const newOwnerName = document.getElementById('addNewOwnerName')?.value?.trim();

    if (!name) { showToast('Name is required', 'error'); return; }
    
    // Create new owner if provided
    if (newOwnerName) {
      const ownerResult = await api.post('/api/owners', { name: newOwnerName });
      if (ownerResult.error) { showToast(ownerResult.error, 'error'); return; }
      ownerId = ownerResult.id;
      await loadOwners();
    }

    if (!ownerId) { showToast('Please select an owner', 'error'); return; }

    const result = await api.post('/api/horses', { name, barn_name: barn, owner_id: parseInt(ownerId), notes });
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
    const horse = state.selectedHorse || state.horses.find(h => h.id === id);
    if (!horse) return;
    state.modal = 'editHorse';
    state.modalData = { id: horse.id, name: horse.name, barn_name: horse.barn_name, owner_id: horse.owner_id, notes: horse.notes };
    render();
  }

  async function saveEditHorse() {
    const d = state.modalData;
    const name = document.getElementById('editHorseName').value.trim();
    const barn_name = document.getElementById('editHorseBarn').value.trim();
    const owner_id = parseInt(document.getElementById('editHorseOwner').value);
    const notes = document.getElementById('editHorseNotes').value.trim();

    if (!name) { showToast('Name is required', 'error'); return; }

    await api.put('/api/horses/' + d.id, { name, barn_name, owner_id, notes });
    showToast('Horse updated!');
    closeModal();
    await loadGrid();
  }

  async function deactivateHorse(id) {
    if (!confirm('Deactivate this horse? It will be hidden from the grid but not deleted.')) return;
    await api.put('/api/horses/' + id, { active: 0 });
    showToast('Horse deactivated', 'info');
    closeModal();
    await loadGrid();
  }

  async function deleteHorse(id) {
    if (!confirm('Permanently delete this horse and all its treatment records? This cannot be undone.')) return;
    await api.del('/api/horses/' + id);
    showToast('Horse deleted', 'info');
    closeModal();
    await loadGrid();
  }

  function openEditOwnerModal(id) {
    const owner = state.owners.find(o => o.id === id);
    if (!owner) return;
    state.modal = 'editOwner';
    state.modalData = { id: owner.id, name: owner.name, contact: owner.contact, notes: owner.notes };
    render();
  }

  async function saveEditOwner() {
    const d = state.modalData;
    const name = document.getElementById('editOwnerName').value.trim();
    const contact = document.getElementById('editOwnerContact').value.trim();
    const notes = document.getElementById('editOwnerNotes').value.trim();

    if (!name) { showToast('Name is required', 'error'); return; }

    await api.put('/api/owners/' + d.id, { name, contact, notes });
    showToast('Owner updated!');
    await loadOwners();
    state.modal = 'settings';
    state.modalData = null;
    await loadGrid();
    render();
  }

  async function deleteOwner(id) {
    const ownerHorses = state.horses.filter(h => h.owner_id === id);
    if (ownerHorses.length > 0) {
      showToast('Cannot delete: owner still has ' + ownerHorses.length + ' horse(s)', 'error');
      return;
    }
    if (!confirm('Delete this owner permanently?')) return;
    await api.del('/api/owners/' + id);
    showToast('Owner deleted', 'info');
    await loadOwners();
    state.modal = 'settings';
    state.modalData = null;
    await loadGrid();
    render();
  }

  // Settings
  function openSettingsModal() {
    state.modal = 'settings';
    render();
  }

  async function addOwnerFromSettings() {
    const name = document.getElementById('newOwnerInput').value.trim();
    if (!name) return;
    const result = await api.post('/api/owners', { name });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Owner added!');
    await loadOwners();
    state.modal = 'settings';
    render();
  }

  async function addTreatmentType() {
    const name = document.getElementById('newTypeName').value.trim();
    const category = document.getElementById('newTypeCat').value;
    if (!name) return;
    const result = await api.post('/api/treatment-types', { name, category, sort_order: state.types.length + 1 });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('Treatment type added!');
    await loadGrid();
    state.modal = 'settings';
    render();
  }

  function attachEventListeners() {
    // Any additional event listeners can be attached here
  }

  // ==================== INIT ====================
  init();
  </script>
</body>
</html>`;
}

export default app
