/** Demo catalogue + demo run/orders for Indian Store Marseille (delivery to Manosque). See GROCERY-CONTRACT.md §6. */
import type { Product, ProductUnit, Run } from './types.js';

type Row = [
  id: string,
  name: string,
  unit: ProductUnit,
  packLabel: string | null,
  packGrams: number | null,
  priceCents: number,
  aliases: string[],
];

const CATEGORIES: Array<[string, Row[]]> = [
  ['Vegetables', [
    ['okra', 'Okra (Bhindi)', 'kg', null, null, 690, ['bhindi', 'bindi', 'bhendi', 'bhinda', 'lady finger', 'ladyfinger', 'ladies finger', 'gombo', 'okra']],
    ['drumsticks', 'Drumsticks (Saragva)', 'kg', null, null, 990, ['drumstick', 'saragva', 'saragvo', 'sargva', 'saragavo', 'moringa', 'sahjan', 'shevga', 'murungakkai']],
    ['tendli', 'Tendli (Tindora / Ivy gourd)', 'kg', null, null, 790, ['tindora', 'tindola', 'tendli', 'tondli', 'kundru', 'kovakkai', 'ivy gourd', 'tendly']],
    ['dudhi', 'Dudhi (Lauki / Bottle gourd)', 'kg', null, null, 450, ['dudhi', 'doodhi', 'lauki', 'loki', 'ghiya', 'bottle gourd', 'calabash']],
    ['green-chilli', 'Green chilli', 'kg', null, null, 990, ['green chilli', 'green chili', 'chilli', 'chili', 'mirchi', 'marcha', 'hari mirch', 'piment vert']],
    ['curry-leaves', 'Curry leaves', 'bunch', 'pack (approx. 50 g)', null, 199, ['curry leaf', 'kadi patta', 'kadhi patta', 'kari patta', 'limdo', 'mitho limdo', 'meetha neem', 'curry patta', 'kadipatta']],
    ['pooja-coconut', 'Indian coconut for pooja', 'pc', '1 pc', null, 249, ['coconut', 'nariyal', 'naliyer', 'nariyel', 'shriphal', 'pooja coconut', 'puja coconut', 'noix de coco']],
    ['drumstick-leaves', 'Drumstick leaves (Moringa leaves)', 'bunch', 'bunch', null, 299, ['drumstick leaves', 'moringa leaves', 'saragva leaves', 'saragva na pan', 'sahjan patta', 'murungai keerai']],
    ['suran', 'Suran (Elephant foot yam)', 'kg', null, null, 590, ['suran', 'jimikand', 'elephant yam', 'elephant foot yam', 'yam', 'oal']],
    ['taro', 'Taro (Arbi / Colocasia)', 'kg', null, null, 590, ['arbi', 'arvi', 'alvi', 'colocasia', 'taro', 'eddoe', 'chembu', 'patra root']],
    ['small-onion', 'Small onion (Shallots)', 'kg', null, null, 490, ['small onion', 'small onions', 'shallot', 'shallots', 'sambar onion', 'chinna vengayam', 'pearl onion', 'echalote']],
    ['raw-banana', 'Raw banana (Kacha kela)', 'kg', null, null, 490, ['raw banana', 'green banana', 'kacha kela', 'kachcha kela', 'plantain', 'vazhakkai', 'banane plantain']],
    ['flat-beans', 'Flat beans (Papdi / Valor)', 'kg', null, null, 890, ['papdi', 'papadi', 'valor', 'val papdi', 'surti papdi', 'sem', 'flat beans', 'avarakkai', 'hyacinth beans']],
    ['bitter-gourd', 'Bitter gourd (Karela)', 'kg', null, null, 690, ['karela', 'karella', 'karelu', 'karavellam', 'kakarakaya', 'bitter gourd', 'bitter melon', 'pavakkai']],
    ['parwal', 'Parwal (Pointed gourd)', 'kg', null, null, 990, ['parwal', 'parval', 'potol', 'pointed gourd', 'paraval']],
    ['cluster-beans', 'Cluster beans (Gavar)', 'kg', null, null, 890, ['gavar', 'guvar', 'guar', 'gawar', 'cluster beans', 'cluster bean', 'kothavarangai']],
    ['brinjal', 'Brinjal (Baingan / Ringan)', 'kg', null, null, 490, ['baingan', 'baigan', 'ringan', 'ringna', 'brinjal', 'eggplant', 'aubergine']],
    ['indian-garlic', 'Indian garlic (Lasun)', 'kg', null, null, 890, ['garlic', 'lasun', 'lehsun', 'lahsun', 'lasan', 'ail']],
    ['green-papaya', 'Green papaya (Raw papaya)', 'kg', null, null, 450, ['green papaya', 'raw papaya', 'kacha papita', 'papaya', 'papaiya', 'papayu']],
  ]],
  ['Dairy', [
    ['paneer-200g', 'Paneer 200 g', 'pack', '200 g pack', 200, 349, ['paneer', 'panir', 'pnr', 'cottage cheese']],
  ]],
  ['Sweets', [
    ['kaju-katli-250g', 'Kaju katli 250 g', 'pack', '250 g box', 250, 899, ['kaju katli', 'kaju kathli', 'kaju katri', 'kaju barfi', 'kaju burfi', 'kaju', 'katli']],
    ['gulab-jamun-1kg', 'Gulab jamun tin 1 kg', 'pack', '1 kg tin', 1000, 599, ['gulab jamun', 'gulabjamun', 'gulab jamoon', 'gulab jambu', 'jamun']],
    ['rasgulla-1kg', 'Rasgulla tin 1 kg', 'pack', '1 kg tin', 1000, 599, ['rasgulla', 'rasagulla', 'rosogolla', 'rasogolla', 'rasgula']],
    ['soan-papdi-250g', 'Soan papdi 250 g', 'pack', '250 g box', 250, 349, ['soan papdi', 'son papdi', 'sohan papdi', 'soan papri', 'patisa']],
    ['motichoor-ladoo-500g', 'Motichoor ladoo 500 g', 'pack', '500 g box', 500, 999, ['motichoor ladoo', 'motichur ladoo', 'motichoor laddu', 'ladoo', 'laddu', 'ladu', 'laddoo', 'boondi ladoo']],
  ]],
  ['Rice & Atta', [
    ['broken-basmati-20kg', 'Broken basmati rice 20 kg', 'pack', '20 kg bag', 20000, 3499, ['broken basmati', 'broken rice', 'basmati broken', 'tukda basmati']],
    ['basmati-5kg', 'Basmati rice 5 kg', 'pack', '5 kg bag', 5000, 1499, ['basmati', 'basmati rice', 'basmathi', 'rice', 'chawal', 'chaval']],
    ['aashirvaad-atta-5kg', 'Aashirvaad atta 5 kg', 'pack', '5 kg bag', 5000, 1199, ['aashirvaad', 'ashirwad', 'aashirwad', 'ashirvad', 'aashirvad', 'atta', 'aata', 'chakki atta', 'wheat flour']],
    ['aashirvaad-atta-10kg', 'Aashirvaad atta 10 kg', 'pack', '10 kg bag', 10000, 2199, ['aashirvaad', 'ashirwad', 'aashirwad', 'ashirvad', 'aashirvad', 'atta', 'aata', 'chakki atta', 'wheat flour']],
    ['besan-1kg', 'Besan 1 kg', 'pack', '1 kg pack', 1000, 399, ['besan', 'beshan', 'gram flour', 'chana flour', 'chickpea flour', 'chana atta']],
    ['poha-1kg', 'Poha 1 kg', 'pack', '1 kg pack', 1000, 349, ['poha', 'pauva', 'pohe', 'powa', 'flattened rice', 'beaten rice', 'chivda rice']],
    ['sooji-1kg', 'Sooji / Rava 1 kg', 'pack', '1 kg pack', 1000, 299, ['sooji', 'suji', 'soji', 'rava', 'rawa', 'semolina', 'bombay rava']],
  ]],
  ['Dal & Pulses', [
    ['toor-dal-1kg', 'Toor dal 1 kg', 'pack', '1 kg pack', 1000, 499, ['toor', 'tuvar', 'tuver', 'tur', 'arhar', 'toor dal', 'tuvar dal', 'tur dal', 'pigeon pea']],
    ['moong-dal-1kg', 'Moong dal 1 kg', 'pack', '1 kg pack', 1000, 449, ['moong', 'mung', 'mag', 'moong dal', 'mung dal', 'mag ni dal', 'green gram']],
    ['chana-dal-1kg', 'Chana dal 1 kg', 'pack', '1 kg pack', 1000, 399, ['chana dal', 'chana daal', 'channa dal', 'bengal gram', 'chanadal']],
    ['masoor-dal-1kg', 'Masoor dal 1 kg', 'pack', '1 kg pack', 1000, 399, ['masoor', 'masur', 'masoor dal', 'red lentils', 'lentils']],
    ['urad-dal-1kg', 'Urad dal 1 kg', 'pack', '1 kg pack', 1000, 499, ['urad', 'udad', 'urid', 'urad dal', 'udad dal', 'black gram']],
    ['kabuli-chana-1kg', 'Kabuli chana 1 kg', 'pack', '1 kg pack', 1000, 399, ['kabuli chana', 'kabuli', 'chana', 'chole', 'chhole', 'chickpeas', 'chick peas', 'garbanzo', 'pois chiche']],
    ['rajma-1kg', 'Rajma 1 kg', 'pack', '1 kg pack', 1000, 449, ['rajma', 'rajmah', 'kidney beans', 'red kidney beans', 'haricot rouge']],
  ]],
  ['Spices & Masala', [
    ['turmeric-200g', 'Turmeric powder 200 g', 'pack', '200 g pack', 200, 249, ['turmeric', 'haldi', 'halad', 'curcuma', 'manjal']],
    ['chilli-powder-200g', 'Red chilli powder 200 g', 'pack', '200 g pack', 200, 299, ['chilli powder', 'chili powder', 'red chilli', 'lal mirch', 'mirchi powder', 'marchu', 'lal marchu']],
    ['garam-masala-100g', 'Garam masala 100 g', 'pack', '100 g pack', 100, 249, ['garam masala', 'garam masalo', 'masala']],
    ['mdh-chana-masala', 'MDH Chana masala 100 g', 'pack', '100 g box', 100, 249, ['mdh', 'chana masala', 'chole masala', 'chhole masala', 'mdh chana']],
    ['jeera-200g', 'Jeera (Cumin seeds) 200 g', 'pack', '200 g pack', 200, 299, ['jeera', 'jira', 'zeera', 'cumin', 'cumin seeds', 'jiru']],
    ['hing-50g', 'Hing (Asafoetida) 50 g', 'pack', '50 g box', 50, 349, ['hing', 'heeng', 'asafoetida', 'asafetida', 'perungayam']],
  ]],
  ['Snacks & More', [
    ['aloo-bhujia-400g', "Haldiram's Aloo bhujia 400 g", 'pack', '400 g pack', 400, 449, ['aloo bhujia', 'alu bhujia', 'bhujia', 'haldiram', 'haldirams', 'bhujiya', 'aloo bhujiya']],
    ['parle-g', 'Parle-G biscuits', 'pack', 'family pack', null, 199, ['parle g', 'parle-g', 'parleg', 'parle', 'biscuit', 'biscuits']],
    ['maggi-12', 'Maggi noodles 12-pack', 'pack', '12 x 70 g', 840, 699, ['maggi', 'maggie', 'magi', 'noodles', 'maggi noodles']],
    ['amul-ghee-1l', 'Amul Ghee 1 L', 'pack', '1 L tin', null, 1299, ['ghee', 'ghi', 'amul ghee', 'desi ghee', 'amul']],
    ['mustard-oil-1l', 'Mustard oil 1 L', 'pack', '1 L bottle', null, 599, ['mustard oil', 'sarson', 'sarso', 'sarson ka tel', 'sarson tel', 'rai oil']],
  ]],
];

export const SEED_PRODUCTS: Product[] = CATEGORIES.flatMap(([category, rows], ci) =>
  rows.map(([id, name, unit, packLabel, packGrams, priceCents, aliases], i): Product => ({
    id,
    name,
    category,
    unit,
    packLabel,
    packGrams,
    priceCents,
    aliases: [...new Set(aliases.map((a) => a.toLowerCase()))],
    active: true,
    sort: (ci + 1) * 100 + (i + 1) * 10,
  })),
);

export function demoRun(): Omit<Run, 'id' | 'createdAt'> {
  return {
    town: 'Manosque',
    deliveryDate: '2026-11-06',
    deliveryTime: 'evening, around 6pm',
    pickupSpot: 'School parking, Manosque',
    // Thu 5 Nov 2026 18:00 Europe/Paris (CET, UTC+1) = 17:00 UTC
    cutoffAt: Date.UTC(2026, 10, 5, 17, 0, 0),
    // Sat 31 Oct 2026 18:00 Europe/Paris (CET since 25 Oct) = 17:00 UTC
    vegCutoffAt: Date.UTC(2026, 9, 31, 17, 0, 0),
    status: 'open',
  };
}

export const DEMO_ORDERS: Array<{ phone: string; customerName: string; items: Array<{ productId: string; qty: number }> }> = [
  { phone: '33600000001', customerName: 'Tapan', items: [{ productId: 'broken-basmati-20kg', qty: 1 }] },
  { phone: '33600000002', customerName: 'Soham', items: [{ productId: 'aashirvaad-atta-5kg', qty: 1 }] },
  { phone: '33600000003', customerName: 'Hema', items: [{ productId: 'kaju-katli-250g', qty: 1 }] },
  {
    phone: '33600000004',
    customerName: 'Priya',
    items: [
      { productId: 'okra', qty: 1 },
      { productId: 'curry-leaves', qty: 2 },
      { productId: 'toor-dal-1kg', qty: 1 },
      { productId: 'paneer-200g', qty: 2 },
    ],
  },
  {
    phone: '33600000005',
    customerName: 'Ravi',
    items: [
      { productId: 'drumsticks', qty: 0.5 },
      { productId: 'gulab-jamun-1kg', qty: 1 },
      { productId: 'moong-dal-1kg', qty: 2 },
    ],
  },
];
