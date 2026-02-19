-- Backfill existing crypto assets with 'bought' as default acquisition method
UPDATE crypto_assets SET acquisition_method = 'bought' WHERE acquisition_method IS NULL;
