-- ============================================================
-- 062_api_flow_nodes.sql — Replace a flow's nodes from the public API
--
-- `replace_flow_nodes(flow, nodes)` (052) requires an authenticated
-- dashboard user: it calls auth.uid() and is_account_member(). The public
-- API authenticates with an API key and runs as the service role, where
-- auth.uid() is NULL, so that function refuses it.
--
-- This variant takes the account explicitly and is callable ONLY by the
-- service role. It does the same work (replace all nodes, cancel active
-- runs sitting on a removed node) but first checks that the flow belongs
-- to the account the API key is bound to.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.replace_flow_nodes_for_account(
  p_account_id UUID,
  p_flow_id UUID,
  p_nodes JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_cancelled INTEGER;
BEGIN
  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM flows
  WHERE id = p_flow_id
  FOR UPDATE;

  IF v_account_id IS NULL OR v_account_id <> p_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = '42501';
  END IF;

  DELETE FROM flow_nodes WHERE flow_id = p_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    p_flow_id,
    n->>'node_key',
    n->>'node_type',
    COALESCE(n->'config', '{}'::jsonb),
    COALESCE((n->>'position_x')::INTEGER, 0),
    COALESCE((n->>'position_y')::INTEGER, 0)
  FROM jsonb_array_elements(p_nodes) AS n;

  UPDATE flow_runs r
  SET status = 'cancelled',
      ended_at = NOW(),
      end_reason = 'current_node_removed'
  WHERE r.flow_id = p_flow_id
    AND r.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM flow_nodes fn
      WHERE fn.flow_id = p_flow_id
        AND fn.node_key = r.current_node_key
    );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_flow_nodes_for_account(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_flow_nodes_for_account(UUID, UUID, JSONB) TO service_role;
