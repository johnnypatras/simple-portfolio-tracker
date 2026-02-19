-- Extend entity_type enum to include trade_entry
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'trade_entry';
