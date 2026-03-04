-- Atomic undo for transfer groups: undoes all legs in a single transaction.
-- If any leg fails, the entire operation is rolled back automatically.
-- Also adds DELETE policy for activity_log (needed by transfer cleanup).

-- ── DELETE policy for activity_log ──────────────────────────────
-- Needed by cleanupTransferEntities() to remove activity_log entries
-- for orphaned entities that were hard-deleted after a failed transfer.

CREATE POLICY "users_delete_own_activity" ON activity_log
  FOR DELETE USING ((select auth.uid()) = user_id);

-- ── Stored procedure: undo_transfer_group ───────────────────────
-- Atomically undoes all legs of a transfer group within a single
-- Postgres transaction. SECURITY INVOKER so RLS applies naturally.

CREATE OR REPLACE FUNCTION undo_transfer_group(p_group_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'public'
AS $$
DECLARE
  entry RECORD;
  col_name TEXT;
  col_value TEXT;
  set_clause TEXT;
  existing RECORD;
  immutable_cols TEXT[] := ARRAY['id', 'user_id', 'created_at', 'updated_at', 'deleted_at'];
  allowed_tables TEXT[] := ARRAY[
    'crypto_assets', 'crypto_positions',
    'stock_assets', 'stock_positions',
    'wallets', 'brokers', 'bank_accounts',
    'exchange_deposits', 'broker_deposits',
    'trade_entries'
  ];
  entry_count INT := 0;
BEGIN
  -- Process each un-undone entry in the transfer group
  FOR entry IN
    SELECT *
    FROM activity_log
    WHERE transfer_group_id = p_group_id
      AND undone_at IS NULL
    ORDER BY created_at ASC
  LOOP
    -- Guard: missing undo metadata
    IF entry.entity_id IS NULL OR entry.entity_table IS NULL THEN
      RAISE EXCEPTION 'Entry % missing entity_id or entity_table', entry.id;
    END IF;

    -- Guard: table whitelist
    IF NOT (entry.entity_table = ANY(allowed_tables)) THEN
      RAISE EXCEPTION 'Table "%" not in undo whitelist', entry.entity_table;
    END IF;

    -- Guard: entity must exist and be in correct state
    EXECUTE format(
      'SELECT id, deleted_at FROM %I WHERE id = $1',
      entry.entity_table
    ) INTO existing USING entry.entity_id;

    IF existing IS NULL THEN
      RAISE EXCEPTION 'Entity % in % no longer exists', entry.entity_id, entry.entity_table;
    END IF;

    IF entry.action = 'created' AND existing.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Entity % already deleted', entry.entity_id;
    END IF;
    IF entry.action = 'removed' AND existing.deleted_at IS NULL THEN
      RAISE EXCEPTION 'Entity % already restored', entry.entity_id;
    END IF;
    IF entry.action = 'updated' AND existing.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot undo update — entity % is deleted', entry.entity_id;
    END IF;

    -- Perform the reversal
    CASE entry.action
      WHEN 'created' THEN
        -- Undo creation → soft-delete (cascade trigger handles children)
        EXECUTE format(
          'UPDATE %I SET deleted_at = NOW() WHERE id = $1',
          entry.entity_table
        ) USING entry.entity_id;

      WHEN 'removed' THEN
        -- Undo removal → restore (cascade trigger restores children)
        EXECUTE format(
          'UPDATE %I SET deleted_at = NULL WHERE id = $1',
          entry.entity_table
        ) USING entry.entity_id;

      WHEN 'updated' THEN
        -- Undo update → restore before_snapshot values
        IF entry.before_snapshot IS NULL THEN
          RAISE EXCEPTION 'No before_snapshot for entry %', entry.id;
        END IF;

        -- Build dynamic SET clause from before_snapshot keys.
        -- #>> '{}' extracts values as text; Postgres auto-coerces to column types.
        set_clause := '';
        FOR col_name, col_value IN
          SELECT key, value #>> '{}' FROM jsonb_each(entry.before_snapshot)
        LOOP
          IF NOT (col_name = ANY(immutable_cols)) THEN
            IF set_clause != '' THEN
              set_clause := set_clause || ', ';
            END IF;
            set_clause := set_clause || format('%I = %L', col_name, col_value);
          END IF;
        END LOOP;

        IF set_clause = '' THEN
          RAISE EXCEPTION 'No restorable fields in snapshot for entry %', entry.id;
        END IF;

        EXECUTE format(
          'UPDATE %I SET %s WHERE id = $1',
          entry.entity_table, set_clause
        ) USING entry.entity_id;

      ELSE
        RAISE EXCEPTION 'Cannot undo action type "%"', entry.action;
    END CASE;

    -- Mark entry as undone
    UPDATE activity_log SET undone_at = NOW() WHERE id = entry.id;

    -- Insert non-undoable audit entry (no entity_id → cannot be undone)
    INSERT INTO activity_log (user_id, action, entity_type, entity_name, description)
    VALUES (
      entry.user_id,
      'undone',
      entry.entity_type,
      entry.entity_name,
      format('Undid "%s" on %s', entry.action, entry.entity_name)
    );

    entry_count := entry_count + 1;
  END LOOP;

  IF entry_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'No active transfer legs found');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Transfer reversed (%s legs undone)', entry_count)
  );

EXCEPTION WHEN OTHERS THEN
  -- Implicit subtransaction: all changes within this block are rolled back
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;
