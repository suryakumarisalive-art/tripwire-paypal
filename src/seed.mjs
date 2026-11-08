// The demo store's starting catalog: a fictional electronics shop ("Northwind Supply") selling real products at
// typical US retail prices. history: [daysAgo, priceCents] gives each item a 30-day price record.
const flat = (cents, dips = []) => {
  const h = [];
  for (let d = 30; d >= 1; d -= 3) h.push([d, cents]);
  for (const [d, c] of dips) h.push([d, c]);
  return h;
};

export const SEED_CATALOG = Object.freeze([
  { sku: 'TV-BRAVIA-65', name: 'Sony Bravia 7 65" 4K Mini LED TV', category: 'TVs', description: '65-inch 4K HDR Mini LED smart TV, 2024 model.', priceCents: 129_900, costCents: 98_000, history: flat(129_900, [[12, 119_900]]) },
  { sku: 'HP-SONY-XM5', name: 'Sony WH-1000XM5 Wireless Headphones', category: 'Audio', description: 'Noise-cancelling over-ear Bluetooth headphones.', priceCents: 34_999, costCents: null, history: flat(34_999, [[9, 29_999]]) },
  { sku: 'LEGO-75192', name: 'LEGO Star Wars Millennium Falcon 75192', category: 'Toys', description: 'Ultimate Collector Series set, 7,541 pieces.', priceCents: 84_999, costCents: null, history: flat(84_999) },
  { sku: 'DRONE-MINI4', name: 'DJI Mini 4 Pro Drone', category: 'Cameras', description: 'Under-249 g camera drone with 4K/60fps HDR video.', priceCents: 75_900, costCents: 61_000, history: flat(75_900) },
  { sku: 'CHAIR-AERON', name: 'Herman Miller Aeron Chair, Size B', category: 'Office', description: 'Ergonomic office chair with PostureFit support.', priceCents: 139_500, costCents: null, history: flat(139_500) },
  { sku: 'KB-Q1PRO', name: 'Keychron Q1 Pro Mechanical Keyboard', category: 'Computing', description: 'Wireless 75% aluminium mechanical keyboard.', priceCents: 19_900, costCents: 12_000, history: flat(19_900) },
  { sku: 'VAC-DYSON-V15', name: 'Dyson V15 Detect Cordless Vacuum', category: 'Home', description: 'Cordless stick vacuum with laser dust detection.', priceCents: 74_999, costCents: null, history: flat(74_999, [[6, 64_999]]) },
  { sku: 'KETTLE-STAGG', name: 'Fellow Stagg EKG Electric Kettle', category: 'Kitchen', description: 'Pour-over electric kettle with temperature control.', priceCents: 16_500, costCents: 9_500, history: flat(16_500) },
]);

// Preset CSV imports for the demo console. Each one is a real kind of mistake (or a real sale) a store makes.
export const DEMO_IMPORTS = Object.freeze({
  decimal_slip: {
    title: 'Supplier feed with a slipped decimal',
    csv: 'sku,name,price\nTV-BRAVIA-65,,129.90\nKB-Q1PRO,,189.00\nKETTLE-STAGG,,165.00\n',
  },
  new_products: {
    title: 'New products, no price history',
    csv: 'sku,name,price,category,description\nAIRPODS-PRO2,Apple AirPods Pro 2 (USB-C),24.90,Audio,Wireless earbuds with active noise cancellation.\nANKER-737,Anker 737 Power Bank 24000mAh,109.99,Accessories,140W portable charger for laptops and phones.\n',
  },
  black_friday: {
    title: 'Black Friday sales, 26-27% off: the AI vouches, they sell',
    csv: 'sku,name,price\nHP-SONY-XM5,,259.99\nVAC-DYSON-V15,,549.99\n',
  },
  // Illustrative, not a documented sale: a doorbuster more than 50% below the 30-day typical price. It keeps selling, but
  // every order is only authorized until the merchant confirms the price (or, if the AI calls it implausible, it is held).
  doorbuster: {
    title: 'A doorbuster, 53% off: it keeps selling, capture waits for you',
    csv: 'sku,name,price\nVAC-DYSON-V15,,349.99\n',
  },
});
