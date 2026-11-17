-- Where a discount is applied, and why extraction skipped a deal on its own.

-- product  = reduced item prices (sale prices, BOGO, bundles, collection or automatic sitewide markdowns)
-- order    = taken off the cart total at checkout (codes, spend $X save $Y)
-- shipping = free or reduced shipping
ALTER TABLE deals ADD COLUMN promo_type TEXT CHECK (promo_type IN ('product', 'order', 'shipping'));

-- Set when extraction rejects a deal automatically (e.g. first order only). NULL for deals Ryan rejected.
ALTER TABLE deals ADD COLUMN auto_rejected TEXT;

-- Best guess for deals already in the database.
UPDATE deals SET promo_type = CASE
  WHEN deal_type = 'free_shipping' THEN 'shipping'
  WHEN scope IN ('product', 'collection') OR deal_type IN ('bogo', 'bundle', 'price_drop') THEN 'product'
  ELSE 'order'
END;

-- Drafts already waiting that are first-order / new-customer only: skip them (they can be restored).
UPDATE deals SET status = 'rejected', auto_rejected = 'First order / new customers only',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'draft' AND new_customers_only = 1;
