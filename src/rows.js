export const RULES = Object.freeze([
  { key: 'r30', label: '+30s' },
  { key: 'r60', label: '+60s' },
  { key: 'rzero', label: 'Zero flow / +120s' },
  { key: 'rleader', label: 'Leader sell / +1200s' },
  { key: 'rtarget', label: '1.3x / +120s' },
  { key: 'r1200', label: 'Hold +20 min' },
]);

export const COLUMNS = Object.freeze([
  'id', 'token', 'leader_wallet', 'leader_signature', 'detected_at',
  'leader_block_time', 'leader_transaction_status', 'leader_buy_sol', 'feed',
  'log_notification_at', 'transaction_decode_delay_ms',
  'token_created_at', 'token_age_seconds', 'token_age_source', 'token_age_reference',
  'curve_sol_at_leader_buy', 'curve_virtual_sol_at_leader_buy', 'curve_at_leader_buy_source',
  'subscription_active_at', 'subscription_delay_ms', 'subscription_capacity_limited',
  'curve_sol_at_detection', 'curve_virtual_sol_at_detection',
  'curve_at_detection_source', 'curve_sample_delay_ms', 'entry_target_at',
  'entry_at', 'entry_delay_ms', 'entry_raw_price', 'entry_price', 'stake_sol',
  'buy_fee_sol', 'network_fee_sol',
  ...[5, 15, 60].flatMap((seconds) => [
    `copier_count_${seconds}`, `copier_sol_${seconds}`,
  ]),
  ...[5, 15, 30, 60, 120, 300, 600, 1200].flatMap((seconds) => [
    `price_${seconds}`, `multiple_${seconds}`, `sample_at_${seconds}`,
    `sample_delay_ms_${seconds}`,
  ]),
  'leader_sold', 'leader_sell_at', 'leader_sell_delay_seconds',
  'leader_sell_signature', 'peak_price', 'peak_multiple', 'peak_at',
  'price_samples', 'ws_gap_count', 'data_quality', 'quality_notes', 'status',
  ...RULES.flatMap(({ key }) => [
    'net_multiple', 'net_pnl_sol', 'exit_price', 'exit_raw_price', 'trigger_at',
    'exit_at', 'delay_ms', 'reason',
  ].map((field) => `${key}_${field}`)),
]);
