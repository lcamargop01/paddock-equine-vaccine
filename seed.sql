-- Seed stables
INSERT OR IGNORE INTO stables (name, pin) VALUES ('Double H', '1234');

-- Seed vets
INSERT OR IGNORE INTO vets (name, email, pin) VALUES ('Dr. Leah Patipa', 'leah@paddockequine.com', '1234');

-- Seed owners (with stable_id = 1 for Double H)
INSERT OR IGNORE INTO owners (name, stable_id) VALUES ('HH', 1);
INSERT OR IGNORE INTO owners (name, stable_id) VALUES ('Carr', 1);
INSERT OR IGNORE INTO owners (name, stable_id) VALUES ('Creel', 1);

-- Seed treatment types
-- Vaccines
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Flu/Rhino', 'vaccine', 1, '#3A8A4E');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('EWT/WNV', 'vaccine', 2, '#3A8A4E');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Potomac', 'vaccine', 3, '#3A8A4E');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Rabies', 'vaccine', 4, '#3A8A4E');

-- Tests / Procedures
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Coggins', 'test', 5, '#5B7FA5');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('McMaster', 'test', 6, '#5B7FA5');

-- Maintenance
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Dentist', 'maintenance', 7, '#8B6BAE');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Deworm', 'maintenance', 8, '#8B6BAE');

-- Joint Injections
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Coffins', 'injection', 9, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Front Fetlocks', 'injection', 10, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Hind Fetlocks', 'injection', 11, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Hocks', 'injection', 12, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Stifles', 'injection', 13, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('SI', 'injection', 14, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Back', 'injection', 15, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Neck', 'injection', 16, '#D4894A');
INSERT OR IGNORE INTO treatment_types (name, category, sort_order, color) VALUES ('Hind Coffin', 'injection', 17, '#D4894A');

-- Seed horses (owner_id: HH=1, Carr=2, Creel=3; vet_id: Dr. Leah=1)
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Ice Spice', 'Ice Spice', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH N Joy', 'Nico', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Marvin Gardens', 'Marvin', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Griffin', 'Griffin', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Jamil Fields', 'Jimmy', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Kingdom PS', 'Buddy', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Aspy', 'Aspy', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Ginger', 'Ginger', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Jumping Jack Flash', 'Jack', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Moonrise Kingdom', 'Poncho', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Leandro', 'Leandro', 1, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Dolitaire Chavannaise', 'Dolly', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Calgary BGM Z', 'Jerry', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Chahitane D''Aragon', 'Barbie', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Hascombe Verona', 'Vivi', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Noble Tropicana', 'Tropicana', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Blue Moon', 'Moonie', 2, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('HH Mo Town', 'Mo Town', 3, 1);
INSERT OR IGNORE INTO horses (name, barn_name, owner_id, vet_id) VALUES ('Malle Balle', 'Malle Balle', 3, 1);

-- Link existing owners to Double H stable
UPDATE owners SET stable_id = 1 WHERE stable_id IS NULL;

-- Link existing horses to Dr. Leah
UPDATE horses SET vet_id = 1 WHERE vet_id IS NULL;
