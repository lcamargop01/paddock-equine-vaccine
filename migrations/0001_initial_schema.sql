-- Owners table
CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Horses table
CREATE TABLE IF NOT EXISTS horses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barn_name TEXT,
  owner_id INTEGER NOT NULL,
  notes TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES owners(id)
);

-- Treatment categories (vaccines, procedures, joint injections)
CREATE TABLE IF NOT EXISTS treatment_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'vaccine',
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT '#3A8A4E'
);

-- Treatment records (dates for each horse + treatment type)
CREATE TABLE IF NOT EXISTS treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horse_id INTEGER NOT NULL,
  treatment_type_id INTEGER NOT NULL,
  treatment_date DATE,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (horse_id) REFERENCES horses(id) ON DELETE CASCADE,
  FOREIGN KEY (treatment_type_id) REFERENCES treatment_types(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_horses_owner ON horses(owner_id);
CREATE INDEX IF NOT EXISTS idx_horses_active ON horses(active);
CREATE INDEX IF NOT EXISTS idx_treatments_horse ON treatments(horse_id);
CREATE INDEX IF NOT EXISTS idx_treatments_type ON treatments(treatment_type_id);
CREATE INDEX IF NOT EXISTS idx_treatments_date ON treatments(treatment_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_treatments_unique ON treatments(horse_id, treatment_type_id);
