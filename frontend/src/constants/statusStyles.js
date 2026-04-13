/**
 * constants/statusStyles.js
 */

// Badge color map: "bgColor textColor borderColor"
const STATUS_STYLE = {
  job: {
    JOB_CREATED:                '#fef9c3 #713f12 #fde047',
    ASSIGNED:                   '#dbeafe #1e40af #93c5fd',
    ACCEPTED:                   '#ede9fe #4c1d95 #c4b5fd',
    IN_PROGRESS:                '#f3e8ff #6b21a8 #d8b4fe',
    WAITING_FOR_PRICE:          '#ffedd5 #9a3412 #fdba74',
    CUSTOMER_APPROVAL_PENDING:  '#fee2e2 #991b1b #fca5a5',
    PAYMENT_PENDING:            '#fce7f3 #9d174d #f9a8d4',
    COMPLETED:                  '#d1fae5 #064e3b #6ee7b7',
    CANCELLED:                  '#f1f5f9 #475569 #cbd5e1',
  },
  tech: {
    AVAILABLE: '#d1fae5 #064e3b #6ee7b7',
    BUSY:      '#fef9c3 #713f12 #fde047',
    OFFLINE:   '#f1f5f9 #475569 #cbd5e1',
  },
};

export function badgeStyle(map, val) {
  const v = STATUS_STYLE[map]?.[val] || '#f1f5f9 #475569 #cbd5e1';
  const [bg, color, border] = v.split(' ');
  return {
    background:   bg,
    color,
    border:       `1px solid ${border}`,
    padding:      '2px 8px',
    borderRadius:  3,
    fontSize:      11,
    fontWeight:    700,
    display:      'inline-block',
    whiteSpace:   'nowrap',
    fontFamily:   "'Times New Roman', Times, serif",
  };
}

export const JOB_TRANSITIONS = {
  JOB_CREATED:               ['ASSIGNED', 'CANCELLED'],
  ASSIGNED:                  ['ACCEPTED', 'CANCELLED'],
  ACCEPTED:                  ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS:               ['WAITING_FOR_PRICE', 'CUSTOMER_APPROVAL_PENDING', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED'],
  WAITING_FOR_PRICE:         ['CUSTOMER_APPROVAL_PENDING'],
  CUSTOMER_APPROVAL_PENDING: ['PAYMENT_PENDING', 'WAITING_FOR_PRICE'],
  PAYMENT_PENDING:           ['COMPLETED', 'CANCELLED'],
  COMPLETED:                 [],
  CANCELLED:                 [],
};

export const ALL_JOB_STATUSES = [
  'JOB_CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS',
  'WAITING_FOR_PRICE', 'CUSTOMER_APPROVAL_PENDING',
  'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED',
];

// Settings metadata
export const SMETA = {
  commission_percentage:   { l: 'Commission %',           u: '%',    d: 'Platform commission on each job' },
  cancellation_fine:       { l: 'Cancellation Fine',      u: '₹',    d: 'Penalty when technician cancels' },
  min_wallet_balance:      { l: 'Min Wallet Balance',     u: '₹',    d: 'Max balance to accept jobs' },
  max_active_jobs:         { l: 'Max Active Jobs',        u: 'jobs', d: 'Max simultaneous jobs per tech' },
  offer_timeout_seconds:   { l: 'Offer Timeout',          u: 'sec',  d: 'Time for tech to respond to offer' },
  max_dispatch_attempts:   { l: 'Max Dispatch Waves',     u: 'waves',d: 'How many dispatch waves before cancel' },
  min_commission_amount:   { l: 'Min Commission',         u: '₹',    d: 'Minimum commission amount' },
  visiting_fee:            { l: 'Visiting Fee',           u: '₹',    d: 'Fixed inspection charge' },
  dispatch_radius_km:      { l: 'Dispatch Radius',        u: 'km',   d: 'Search radius for technicians' },
  surge_multiplier:        { l: 'Surge Multiplier',       u: '×',    d: 'Price multiplier during surge' },
  surge_enabled:           { l: 'Surge Pricing',          u: '',     d: 'Enable/disable dynamic surge', bool: true },
  max_offers_per_wave:     { l: 'Offers per Wave',        u: '',     d: 'Techs contacted per dispatch wave' },
  job_accept_timeout_min:  { l: 'Job Accept Timeout',     u: 'min',  d: 'Minutes before unaccepted job resets' },
  conv_expire_hours:       { l: 'Conversation Expiry',    u: 'hrs',  d: 'Hours before conversation session expires' },
  price_approval_timeout:  { l: 'Price Approval Timeout', u: 'min',  d: 'Minutes for customer to approve price' },
  payment_link_expire_min: { l: 'Payment Link Expiry',    u: 'min',  d: 'Minutes before Razorpay link expires' },
  arrived_price_timeout_min: { l: 'Arrived Price Timeout', u: 'min', d: 'Minutes after arrival before auto-cancel if no price submitted' },
  in_progress_timeout_hours: { l: 'In-Progress Timeout',   u: 'hrs', d: 'Hours before IN_PROGRESS job is auto-completed' },
};

export const SETTING_GROUPS = [
  { title: 'Financial',           keys: ['commission_percentage', 'min_commission_amount', 'cancellation_fine', 'visiting_fee'] },
  { title: 'Dispatch & Matching', keys: ['dispatch_radius_km', 'max_dispatch_attempts', 'max_offers_per_wave', 'offer_timeout_seconds', 'job_accept_timeout_min', 'arrived_price_timeout_min', 'in_progress_timeout_hours'] },
  { title: 'Technician Rules',    keys: ['min_wallet_balance', 'max_active_jobs'] },
  { title: 'Payment & Pricing',   keys: ['price_approval_timeout', 'payment_link_expire_min'] },
  { title: 'Surge Pricing',       keys: ['surge_enabled', 'surge_multiplier'] },
  { title: 'Conversations',       keys: ['conv_expire_hours'] },
];
