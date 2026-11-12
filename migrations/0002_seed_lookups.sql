-- Starting categories and cannabinoids. A category with no live deals shows grayed out on the site.

INSERT INTO categories (slug, name, sort) VALUES
  ('gummies', 'Gummies', 10),
  ('edibles', 'Other edibles', 20),
  ('beverages', 'Beverages', 30),
  ('tinctures', 'Tinctures & oils', 40),
  ('capsules', 'Capsules & softgels', 50),
  ('vapes', 'Vapes & cartridges', 60),
  ('flower', 'Flower', 70),
  ('pre-rolls', 'Pre-rolls', 80),
  ('concentrates', 'Concentrates', 90),
  ('topicals', 'Topicals', 100),
  ('bath-body', 'Bath & body', 110),
  ('sleep', 'Sleep products', 120),
  ('pet', 'Pet products', 130),
  ('accessories', 'Accessories', 140),
  ('bundles', 'Bundles & samplers', 150);

INSERT INTO cannabinoids (slug, name, grp, enabled, sort) VALUES
  ('cbd', 'CBD', 'non_intoxicating', 1, 10),
  ('cbg', 'CBG', 'non_intoxicating', 1, 20),
  ('cbn', 'CBN', 'non_intoxicating', 1, 30),
  ('cbc', 'CBC', 'non_intoxicating', 1, 40),
  ('thcv', 'THCV', 'non_intoxicating', 1, 50),
  -- Hemp-derived THC and semi-synthetics: in the schema now, hidden from filters until the site covers them.
  ('delta-9-thc', 'Delta-9 THC (hemp)', 'hemp_thc', 0, 100),
  ('delta-8-thc', 'Delta-8 THC', 'hemp_thc', 0, 110),
  ('thca', 'THCA', 'hemp_thc', 0, 120),
  ('hhc', 'HHC', 'semi_synthetic', 0, 200),
  ('thcp', 'THCP', 'semi_synthetic', 0, 210);
