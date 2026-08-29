// All real-world naming is replaced at bake time. The geometry is real; the
// identity is invented. The mapping is emitted alongside the data so real names
// can be restored later if that call is ever made.

export const CITY = {
  name: 'Port Verano',
  bay: 'Verano Bay',
  state: 'Florida',        // kept: the setting is a generic Gulf-coast Florida city
};

// Deterministic real -> invented street naming. Keyed on the real name so the
// same street always gets the same invented name across bakes.
const STREET_POOL = [
  'Marlin Street', 'Halyard Avenue', 'Tarpon Row', 'Verano Boulevard', 'Kestrel Street',
  'Sablefish Lane', 'Cordage Avenue', 'Lantern Street', 'Bittern Avenue', 'Mercado Street',
  'Quintana Avenue', 'Dovetail Street', 'Saltgrass Avenue', 'Ironwood Street', 'Pelican Row',
  'Cannery Street', 'Windlass Avenue', 'Mangrove Street', 'Solano Avenue', 'Corbina Street',
  'Barquentine Row', 'Hollis Street', 'Ravello Avenue', 'Osprey Point Road', 'Fathom Street',
  'Bellweather Avenue', 'Anchorage Street', 'Sandpiper Row', 'Calusa Avenue', 'Trawler Street',
  'Vermilion Street', 'Keelson Avenue', 'Palmetto Row', 'Redfish Street', 'Alcazar Avenue',
  'Spinnaker Street', 'Juniper Row', 'Mirador Avenue', 'Shoalwater Street', 'Cutwater Avenue',
];

// A few anchors get hand-picked names so the district reads deliberately.
const ANCHORS = {
  'Main Street': 'Marlin Street',
  'North Gulfstream Avenue': 'North Halyard Avenue',
  'South Gulfstream Avenue': 'South Halyard Avenue',
  'North Pineapple Avenue': 'North Tarpon Row',
  'South Pineapple Avenue': 'South Tarpon Row',
  'North Lemon Avenue': 'North Lantern Street',
  'South Lemon Avenue': 'South Lantern Street',
  'North Palm Avenue': 'North Cordage Avenue',
  'South Palm Avenue': 'South Cordage Avenue',
  'Bayfront Drive': 'Bayfront Drive',        // generic enough to keep
  'Cocoanut Avenue': 'Calusa Avenue',
  'North Orange Avenue': 'North Vermilion Street',
  'South Orange Avenue': 'South Vermilion Street',
  'North Osprey Avenue': 'North Osprey Point Road',
  'South Osprey Avenue': 'South Osprey Point Road',
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const assigned = new Map();
const used = new Set(Object.values(ANCHORS));

export function fictionalizeStreet(real) {
  if (!real) return undefined;
  if (assigned.has(real)) return assigned.get(real);
  if (ANCHORS[real]) { assigned.set(real, ANCHORS[real]); return ANCHORS[real]; }
  // Preserve the N/S/E/W prefix so the grid still reads as a grid.
  const dir = real.match(/^(North|South|East|West)\s+/);
  let base = STREET_POOL[hash(real) % STREET_POOL.length];
  let i = 0;
  while (used.has((dir ? dir[1] + ' ' : '') + base)) {
    base = STREET_POOL[(hash(real) + ++i) % STREET_POOL.length];
    if (i > STREET_POOL.length) { base = `${base} ${i}`; break; }
  }
  const name = (dir ? dir[1] + ' ' : '') + base;
  used.add(name);
  assigned.set(real, name);
  return name;
}

export function nameMapping() { return Object.fromEntries(assigned); }

// Storefront / signage pool, all invented.
export const BUSINESSES = [
  'Corvid Coffee', 'Halcyon Books', 'The Brass Cleat', 'Verano Optical', 'Mira Loma Cantina',
  'Bright & Sons Hardware', 'Nautilus Records', 'Fennel & Rye', 'Aster Dry Cleaning',
  'Puerto Azul Grill', 'Lumen Camera', 'The Salt Room', 'Ravenswood Tailors', 'Dockside Pharmacy',
  'Tessellate Tile Co.', 'Gilder Bank', 'Marrow & Vine', 'Kestrel Cycles', 'Pomelo Bakery',
  'Sable Street Barbers', 'Vantage Realty', 'Wildcat Arcade', 'Orchid Lane Florist', 'Cassava',
];
