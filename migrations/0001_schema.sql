-- Daily Green Deals schema. Two levels: companies (store-wide facts) and deals (offers).
-- Product-specific deals get rows in deal_products; sitewide deals don't.
-- Times are ISO 8601 UTC strings. JSON columns hold arrays of slugs.

CREATE TABLE companies (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  website            TEXT,
  logo_url           TEXT,
  description        TEXT,
  cannabinoids_sold  TEXT NOT NULL DEFAULT '[]',  -- JSON: ["cbd","cbn"]
  categories_sold    TEXT NOT NULL DEFAULT '[]',  -- JSON: ["gummies","tinctures"]
  shipping_notes     TEXT,
  free_shipping_min  REAL,                        -- USD order minimum for free shipping
  ships_international INTEGER,                    -- 1 / 0 / NULL = unknown
  lab_results_url    TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Where each store ships. Exists now, filled in later for the ships-to-state filter.
CREATE TABLE company_shipping (
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  region       TEXT NOT NULL,                     -- ISO 3166-2, e.g. US-CO
  ships        INTEGER NOT NULL,                  -- 1 / 0
  source_url   TEXT,
  verified_at  TEXT,
  PRIMARY KEY (company_id, region)
);

-- Which address belongs to which store. Either a full signup address
-- (vivimu@dailygreendeals.com) or a sender domain prefixed with @ (@vivimu.com) as a fallback.
CREATE TABLE email_sources (
  address     TEXT PRIMARY KEY,                  -- lowercase
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE inbound_emails (
  id           INTEGER PRIMARY KEY,
  message_id   TEXT UNIQUE,                      -- the email's Message-ID header, for de-duplication
  r2_key       TEXT NOT NULL,
  alias        TEXT,                             -- the store signup address it was sent to
  from_address TEXT,
  subject      TEXT,
  sent_at      TEXT,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  company_id   INTEGER REFERENCES companies(id),
  status       TEXT NOT NULL DEFAULT 'received'
               CHECK (status IN ('received', 'extracted', 'unmatched', 'failed', 'ignored')),
  kind         TEXT,                             -- deals | no_deals | confirmation (set by extraction)
  confirmation_url TEXT,                         -- signup confirmation link for Ryan to click
  error        TEXT,
  deals_found  INTEGER
);
CREATE INDEX inbound_emails_received ON inbound_emails (received_at);
CREATE INDEX inbound_emails_status ON inbound_emails (status);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES categories(id),
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cannabinoids (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  grp      TEXT NOT NULL,                        -- non_intoxicating | hemp_thc | semi_synthetic
  enabled  INTEGER NOT NULL DEFAULT 1,           -- shown in filters
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deals (
  id                  INTEGER PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope               TEXT NOT NULL CHECK (scope IN ('sitewide', 'collection', 'product')),
  deal_type           TEXT NOT NULL CHECK (deal_type IN
                        ('percent_off', 'dollars_off', 'bogo', 'bundle', 'free_gift',
                         'free_shipping', 'tiered', 'price_drop', 'other')),
  title               TEXT NOT NULL,             -- one line, e.g. "30% off sitewide"
  value_pct           REAL,                      -- 30 for 30% off
  value_amount        REAL,                      -- USD off
  value_text          TEXT,                      -- "Buy 2 get 1 free", "Spend $100 get 25% off"
  collection_name     TEXT,                      -- for scope = collection, e.g. "All gummies"
  category_slugs      TEXT NOT NULL DEFAULT '[]',-- JSON, for collection-scope deals
  code                TEXT,
  url                 TEXT,
  starts_at           TEXT,
  ends_at             TEXT,
  is_ongoing          INTEGER NOT NULL DEFAULT 0,
  min_order           REAL,
  new_customers_only  INTEGER NOT NULL DEFAULT 0,
  subscribe_only      INTEGER NOT NULL DEFAULT 0,
  restrictions        TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'approved', 'rejected', 'expired')),
  featured            INTEGER NOT NULL DEFAULT 0,
  needs_review        TEXT,                      -- why a live deal was flagged (e.g. not seen in 14 days)
  confidence          REAL,                      -- 0..1 from extraction
  pending_changes     TEXT,                      -- JSON: an "update" from extraction awaiting approval
  first_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source_email_id     INTEGER REFERENCES inbound_emails(id),
  approved_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX deals_status_ends ON deals (status, ends_at);
CREATE INDEX deals_company ON deals (company_id, status);

CREATE TABLE deal_products (
  id              INTEGER PRIMARY KEY,
  deal_id         INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_name    TEXT NOT NULL,
  product_url     TEXT,
  category_slug   TEXT REFERENCES categories(slug),
  cannabinoids    TEXT NOT NULL DEFAULT '[]',    -- JSON: [{"slug":"cbd","mg":10}]
  mg_per_unit     REAL,                          -- total cannabinoid mg per gummy/ml/etc.
  units_per_pack  INTEGER,
  price_regular   REAL,
  price_deal      REAL
);
CREATE INDEX deal_products_deal ON deal_products (deal_id);
CREATE INDEX deal_products_category ON deal_products (category_slug);

CREATE TABLE subscribers (
  id                 INTEGER PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  confirmed_at       TEXT,
  unsubscribe_token  TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE alerts (
  id             INTEGER PRIMARY KEY,
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  filter         TEXT NOT NULL,                  -- the /deals/ query string, e.g. "category=gummies&max_mg=10"
  frequency      TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
  last_sent_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE digest_sends (
  id             INTEGER PRIMARY KEY,
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  sent_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deal_ids       TEXT NOT NULL,                  -- JSON array
  status         TEXT NOT NULL                   -- sent | failed
);
