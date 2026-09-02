// Real streets, invented businesses.
//
// This file used to replace all real-world naming at bake time, and said: "the
// mapping is emitted alongside the data so real names can be restored later if
// that call is ever made." That call has been made. The district is downtown
// Sarasota - the extract is centred on 27.335, -82.54125 and carries Ringling
// Boulevard, Main Street, Cocoanut Avenue and Five Points - and the brief is now
// for it to read as the real place.
//
// What changed, and what deliberately did not:
//
//   STREETS and the CITY are real. They are factual public geography, already
//   present in the OpenStreetMap extract this is baked from, and renaming them
//   was the single thing stopping the map from reading as Sarasota.
//
//   BUSINESSES, shopfronts, signage and logos stay invented, and the pool below
//   is untouched. The buildings are authored massing on real footprints, not
//   surveyed premises: only 5.7% of them carry a real height and 28.1% were
//   hand-authored. Putting a real business's name on a building we approximated
//   would be claiming a likeness we have not earned.
//
// The mapping machinery is kept rather than deleted, so the swap is reversible
// and so `nameMapping()` still records what was done.
export const CITY = {
  name: 'Sarasota',
  bay: 'Sarasota Bay',
  state: 'Florida',
};

// Set to false to restore the invented street names; the pool and anchor table
// below are retained for that.
const REAL_STREET_NAMES = true;

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
  if (REAL_STREET_NAMES) { assigned.set(real, real); return real; }
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
