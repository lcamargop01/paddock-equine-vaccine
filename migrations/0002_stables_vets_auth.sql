-- Stables table (barns/locations)
CREATE TABLE IF NOT EXISTS stables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact TEXT,
  address TEXT,
  notes TEXT,
  pin TEXT NOT NULL DEFAULT '1234',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vets table
CREATE TABLE IF NOT EXISTS vets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  pin TEXT NOT NULL DEFAULT '1234',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table for simple token-based auth
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('vet', 'stable')),
  ref_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- Add stable_id to owners table
ALTER TABLE owners ADD COLUMN stable_id INTEGER REFERENCES stables(id);

-- Add vet_id to horses for tracking which vet manages the horse
ALTER TABLE horses ADD COLUMN vet_id INTEGER REFERENCES vets(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_owners_stable ON owners(stable_id);
CREATE INDEX IF NOT EXISTS idx_stables_active ON stables(active);
CREATE INDEX IF NOT EXISTS idx_vets_active ON vets(active);
