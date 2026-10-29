// The demo data: what `npm run seed:demo` (seedDemo.ts) writes, and what
// seedDemo.test.ts proves about it. Kept apart from the runner so the test can
// run it against the in-memory database.
//
// Three shops with menus and tables, forty diners (a dozen of them regulars),
// a manager, and 90 days of closed carts with payments from both providers,
// splits by several diners, refunds with reasons, and the live states a
// manager's page shows: an open cart being ordered, a stale selection, a
// sold-out item in a cart, a payment a provider holds, a diner to pay back,
// and a table deleted with a cart still refundable. Orders are written through
// the real sync, so the sales report has data.
//
// The history has the shapes a sales page should show: a lunch and a dinner
// peak within each shop's hours, regulars who come back and newcomers at every
// shop in any month and on its latest open days, a dish launched in week six,
// refund causes weighted the way a kitchen's are (long waits cluster on busy
// evenings), and one story per shop, strong enough to read through the random
// draws on any day: the café doing well (a rise over the 90 days, a bad week
// five weeks back, its best week the one just gone), the restaurant struggling
// (a fall, and its worst week the one just gone), the pop-up new and growing.
// Days and hours are the shops' own (Europe/London), wherever the seed runs.
//
// Reproducible: every id, name, quantity and date comes from a seeded random
// generator (one main sequence; the café's till and kitchen, added later, draw
// from one of their own so nothing earlier moved) and a reference time (`now`, rounded to the hour), so two runs in
// the same hour write the same documents. The two ids the front end's README
// has carried since 2021 (the demo shop and its QR table) are fixed, so the
// printed QR code stays valid.
//
// Owned: the seed deletes and rewrites only the demo shops' records (by their
// fixed ids), the menu items it created, the carts, orders, pay-backs and card
// payment records of those shops, and the users with its emails (found by
// email, so an existing account keeps its id and sessions; its password is
// replaced only when it differs from the one in the environment).
import { Types } from "mongoose"
import * as bcrypt from "bcrypt"
import UserModel from "../services/users/model"
import ShopModel from "../services/shops/model"
import MenuModel from "../services/menus/model"
import CartModel, { RefundReason } from "../services/carts/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"
import { syncOrder } from "../services/orders/sync"
import env from "../settings/env"
import { fromPence, money, toPence } from "../lib/money"
import { DEFAULT_TIME_ZONE, addDays, dayIn, instantOf, weekdayOf } from "../lib/days"
import { ICartDocument, IManagerLogEntry, INotice, IPayment, IRefund, ISplitItem, PaymentProvider } from "../typings/cart"

// The two ids the front end's README and its QR image point at.
export const DEMO_SHOP_ID = "6158a19282eaef10787cd6f3"
export const DEMO_TABLE_ID = "61702525cc1ec6af70a92f35"
export const DEMO_MANAGER_EMAIL = "manager@mail.com"
export const DEMO_DINER_EMAIL = "frank@mail.com"
export const DEMO_STAFF_EMAIL = "alex.demo@example.com"
// The café's till and kitchen, so the staff list shows the roles below manager.
export const DEMO_TILL_EMAIL = "kim.demo@example.com"
export const DEMO_KITCHEN_EMAIL = "jo.demo@example.com"

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR

// --- A seeded random generator (mulberry32), so a run is reproducible. ---

const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

class Rng {
    private next: () => number
    constructor(seed = 20211109) { this.next = mulberry32(seed) }
    float() { return this.next() }
    int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)) }
    chance(p: number) { return this.next() < p }
    pick<T>(list: readonly T[]) { return list[this.int(0, list.length - 1)] }
    // One of `entries`, each as likely as its weight.
    weighted<T>(entries: readonly (readonly [T, number])[]) {
        let left = this.next() * entries.reduce((sum, [, w]) => sum + w, 0)
        for (const [value, weight] of entries) if ((left -= weight) < 0) return value
        return entries[entries.length - 1][0]
    }
    some<T>(list: readonly T[], n: number) {
        const left = [...list]
        const out: T[] = []
        while (out.length < n && left.length) out.push(left.splice(this.int(0, left.length - 1), 1)[0])
        return out
    }
    hex(chars: number) {
        let s = ""
        while (s.length < chars) s += this.int(0, 0xffff).toString(16).padStart(4, "0")
        return s.slice(0, chars)
    }
    oid() { return new Types.ObjectId(this.hex(24)) }
}

// --- The dataset's shape. ---

// `launchedDaysAgo`: a dish added to the menu part-way through the history.
type Item = { name: string; short_description: string; description: string; price: number; category: "food" | "drinks"; soldOut?: boolean; deleted?: boolean; launchedDaysAgo?: number }
type ShopDef = {
    id: Types.ObjectId
    name: string
    bio: string
    open_times: string
    phone: string
    web_URL: string
    cover: string
    tables: { id: Types.ObjectId; name: string }[]
    deletedTables: { id: Types.ObjectId; name: string; deletedAt: Date }[]
    items: (Item & { id: Types.ObjectId })[]
    // How many visits a day, by day of week (0 = Sunday); none: closed that day.
    visits: (dayOfWeek: number) => [min: number, max: number] | null
    openHour: number
    closeHour: number
    // The busy hours (from, to), where most visits start.
    peaks: [from: number, to: number][]
    // How much busier the last day is than the first (0.3: thirty per cent
    // more; -0.5: half as busy), a straight line through the history.
    growth: number
    // A week (first and last day, as days ago) of half the visits and more
    // refunds, mostly for the wait.
    badWeek?: [from: number, to: number]
    // A week of a third more visits.
    goodWeek?: [from: number, to: number]
    // The first day of its history.
    since: number
}

// A photo per shop and dish, from Wikimedia Commons (each freely licensed:
// public domain, CC0, CC BY or CC BY-SA; the author and licence are on the
// file's page, commons.wikimedia.org/wiki/File:<the file name in the URL>).
// The direct thumbnail URLs, not the Special:FilePath redirect: the redirect
// sends no CORS header, and a cover drawn into a table's QR code needs one.
// Managers replace them from the app.
const PHOTOS: Record<string, string> = {
    "Rocketlit": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Beale_Street_Brews_Counter_%2826499287821%29.jpg/1280px-Beale_Street_Brews_Counter_%2826499287821%29.jpg",
    "Marlow Street Kitchen": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b4/DZ6_2644_Cozy_candlelit_dinner_tables_set_for_an_intimate_evening_at_a_charming_Thai_restaurant.jpg/1280px-DZ6_2644_Cozy_candlelit_dinner_tables_set_for_an_intimate_evening_at_a_charming_Thai_restaurant.jpg",
    "Saturday Market Pop-up": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/52/Jedburgh_Easter_Market_2022_street_food_stall_and_stallholder.jpg/1280px-Jedburgh_Easter_Market_2022_street_food_stall_and_stallholder.jpg",
    "Flat White": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6b/Flat_white_coffee_with_pretty_feather_pattern.jpg/960px-Flat_white_coffee_with_pretty_feather_pattern.jpg",
    "Latte": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9f/Caffe_Latte_cup.jpg/960px-Caffe_Latte_cup.jpg",
    "Espresso": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7d/Afternoon_Coffee_-11_366-_%286682090613%29.jpg/960px-Afternoon_Coffee_-11_366-_%286682090613%29.jpg",
    "Chai": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/80/Chai_Latte_and_Latte_-_The_Mad_Hatter.jpg/960px-Chai_Latte_and_Latte_-_The_Mad_Hatter.jpg",
    "Fresh Orange Juice": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/67/Orange_juice_1_edit1.jpg/960px-Orange_juice_1_edit1.jpg",
    "Sparkling Water": "https://upload.wikimedia.org/wikipedia/commons/c/c1/Ice_water_with_lemon.jpg",
    "Avocado Toast": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2c/Smashed_avocado_%26_poached_eggs_-_M%26S_Caf%C3%A9_2023-12-28.jpg/960px-Smashed_avocado_%26_poached_eggs_-_M%26S_Caf%C3%A9_2023-12-28.jpg",
    "Sourdough Toastie": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/Grilled_Cheese_with_Texas_Toast_%40_Horne%27s.jpg/960px-Grilled_Cheese_with_Texas_Toast_%40_Horne%27s.jpg",
    "Shakshuka": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/18/Shakshuka_by_Calliopejen1.jpg/960px-Shakshuka_by_Calliopejen1.jpg",
    "Granola Bowl": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6c/Yogurt%2C_fruit%2C_granola_bowl_%2834999358091%29.jpg/960px-Yogurt%2C_fruit%2C_granola_bowl_%2834999358091%29.jpg",
    "Pastel de Nata": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f8/Pastel_De_Nata.jpg/960px-Pastel_De_Nata.jpg",
    "Carrot Cake": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c6/Carrot_cake_slice_and_latte_-_Saltmarsh_Farmhouse_%26_Cafe_2024-12-19.jpg/960px-Carrot_cake_slice_and_latte_-_Saltmarsh_Farmhouse_%26_Cafe_2024-12-19.jpg",
    "Pumpkin Soup": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bf/-2021-11-01_Bowl_of_homemade_pumpkin_soup%2C_Trimingham%2C_Norfolk.JPG/960px--2021-11-01_Bowl_of_homemade_pumpkin_soup%2C_Trimingham%2C_Norfolk.JPG",
    "House Red": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e3/Wine_being_poured_into_a_glass.jpg/960px-Wine_being_poured_into_a_glass.jpg",
    "House White": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/ff/Celebrating_with_a_glass_of_white_wine_in_a_lively_bar_setting.jpg/960px-Celebrating_with_a_glass_of_white_wine_in_a_lively_bar_setting.jpg",
    "Pale Ale": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/44/%C3%86r%C3%B8_India_Pale_Ale_%2828592484470%29.jpg/960px-%C3%86r%C3%B8_India_Pale_Ale_%2828592484470%29.jpg",
    "Negroni": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c6/Negroni_served_in_Vancouver_BC.jpg/960px-Negroni_served_in_Vancouver_BC.jpg",
    "Lemonade": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Limonata_%28karaf%29.jpg/960px-Limonata_%28karaf%29.jpg",
    "Burrata": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5c/Salade_caprese_burrata.jpg/960px-Salade_caprese_burrata.jpg",
    "Crab Linguine": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/97/RedDot_Linguine_Crab_Meat_Pasta.jpg/960px-RedDot_Linguine_Crab_Meat_Pasta.jpg",
    "Lamb Shoulder": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/41/Roasted_lamb_shoulder_in_a_pot%2C_Brisbane%2C_2025%2C_01.jpg/960px-Roasted_lamb_shoulder_in_a_pot%2C_Brisbane%2C_2025%2C_01.jpg",
    "Roast Chicken": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7c/Whole_spiced_chicken_%28roasted%29.jpg/960px-Whole_spiced_chicken_%28roasted%29.jpg",
    "Mushroom Risotto": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2c/Risotto_ai_funghi_porcini.JPG/960px-Risotto_ai_funghi_porcini.JPG",
    "Chips": "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/31/Hesburger_French_fries_on_a_plate.jpg/960px-Hesburger_French_fries_on_a_plate.jpg",
    "Tiramisu": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/52/Tiramisu_cake_-_Trading_Post_Coffee_Roasters_2026-01-26.jpg/960px-Tiramisu_cake_-_Trading_Post_Coffee_Roasters_2026-01-26.jpg",
    "Affogato": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/Affogato_al_Caffe.jpg/960px-Affogato_al_Caffe.jpg",
    "Sea Bass": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4d/Grilled_sea_bass_%287906690230%29.jpg/960px-Grilled_sea_bass_%287906690230%29.jpg",
    "Bao Bun": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/78/Taiwanese_burger_.jpg/960px-Taiwanese_burger_.jpg",
    "Dumplings": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/Gyoza_%2852769973678%29.jpg/960px-Gyoza_%2852769973678%29.jpg",
    "Kimchi Fries": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b2/Vegan_BBQ_Boss_Loaded_Waffle_Fries_-_Brewhouse_%26_Kitchen%2C_Worthing_2026-06-08.jpg/960px-Vegan_BBQ_Boss_Loaded_Waffle_Fries_-_Brewhouse_%26_Kitchen%2C_Worthing_2026-06-08.jpg",
    "Mochi": "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/05/Mochi_Ice_Cream.jpg/960px-Mochi_Ice_Cream.jpg",
    "Miso Soup": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/43/Miso_soup_overhead.jpg/960px-Miso_soup_overhead.jpg",
    "Iced Tea": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e1/NCI_iced_tea.jpg/960px-NCI_iced_tea.jpg",
    "Yuzu Lemonade": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c9/Lemonade_with_strawberry.jpg/960px-Lemonade_with_strawberry.jpg",
}
const photo = (subject: string) => {
    const url = PHOTOS[subject]
    if (!url) throw new Error(`No photo for ${subject}`)
    return url
}

// The first seven, with the demo diner, appear in the live states and are
// regulars with the four after them; the rest come once or twice.
const DINERS = [
    { name: "Ada", surname: "Okafor" },
    { name: "Ben", surname: "Lindqvist" },
    { name: "Chloe", surname: "Marsh" },
    { name: "Dev", surname: "Raman" },
    { name: "Eva", surname: "Novak" },
    { name: "Grace", surname: "Achebe" },
    { name: "Hugo", surname: "Ferreira" },
    { name: "Ines", surname: "Castillo" },
    { name: "Jonas", surname: "Weber" },
    { name: "Kemi", surname: "Adeyemi" },
    { name: "Luca", surname: "Moretti" },
    { name: "Maya", surname: "Patel" },
    { name: "Noor", surname: "Haddad" },
    { name: "Oscar", surname: "Nilsson" },
    { name: "Priya", surname: "Nair" },
    { name: "Quentin", surname: "Dubois" },
    { name: "Rosa", surname: "Alvarez" },
    { name: "Sami", surname: "Khoury" },
    { name: "Tomas", surname: "Horvath" },
    { name: "Uma", surname: "Iyer" },
    { name: "Viktor", surname: "Petrov" },
    { name: "Wren", surname: "Bailey" },
    { name: "Ximena", surname: "Rojas" },
    { name: "Yusuf", surname: "Demir" },
    { name: "Zara", surname: "Hussain" },
    { name: "Amara", surname: "Mensah" },
    { name: "Bruno", surname: "Costa" },
    { name: "Celine", surname: "Fournier" },
    { name: "Dara", surname: "Kelly" },
    { name: "Elin", surname: "Berg" },
    { name: "Felix", surname: "Wagner" },
    { name: "Gita", surname: "Rao" },
    { name: "Hana", surname: "Sato" },
    { name: "Idris", surname: "Bello" },
    { name: "Jade", surname: "Thornton" },
    { name: "Kai", surname: "Tanaka" },
    { name: "Leila", surname: "Rahimi" },
    { name: "Mateo", surname: "Silva" },
    { name: "Nia", surname: "Campbell" },
] as const
const REGULARS = 12

// What Stripe says when it won't refund an expired card.
const EXPIRED_CARD = "expired_or_canceled_card"

export interface SeedOptions {
    managerPassword: string
    dinerPassword: string
    // The reference time; rounded down to the hour so reruns within the hour
    // write the same dates.
    now?: Date
    log?: (line: string) => void
}

export interface SeedSummary {
    shops: number
    tables: number
    menuItems: number
    users: number
    carts: number
    payments: number
    refunds: number
    orders: { created: number; updated: number; unchanged: number }
    paybacks: number
}

export const seedDemo = async ({ managerPassword, dinerPassword, now = new Date(), log = () => {} }: SeedOptions): Promise<SeedSummary> => {
    const rng = new Rng()
    const t0 = Math.floor(now.getTime() / HOUR) * HOUR
    const at = (msAgo: number) => new Date(t0 - msAgo)
    // The shops' days are Europe/London's, whatever clock the seed runs on.
    const zone = DEFAULT_TIME_ZONE
    // Counted in days of the calendar, not in 24-hour spans, so a run in the
    // hour after midnight never skips the day the clocks changed.
    const today = dayIn(new Date(t0), zone)
    const dayOf = (daysAgo: number) => addDays(today, -daysAgo)
    // `hour`:`minute` on the shop's clock, `daysAgo` days ago.
    const dayAt = (daysAgo: number, hour: number, minute = 0) => instantOf(dayOf(daysAgo), hour, minute, zone)
    // The live states (a table being ordered at, a payment just made) are
    // placed at the latest moment the shop was open: now while it is, else the
    // last hour of its last open day. So a seed run at night, or a nightly one,
    // writes no order outside the shop's hours, and its report's hours stay
    // the shop's.
    const lastOpen = (shop: Pick<ShopDef, "visits" | "openHour" | "closeHour">) => {
        for (let daysAgo = 0; daysAgo < 8; daysAgo++) {
            const day = dayOf(daysAgo)
            if (!shop.visits(weekdayOf(day))) continue
            const open = instantOf(day, shop.openHour, 0, zone).getTime()
            const close = instantOf(day, shop.closeHour, 0, zone).getTime()
            if (t0 >= open && t0 < close) return t0
            if (t0 >= close) return close - HOUR
        }
        return t0
    }
    const ago = (shop: Pick<ShopDef, "visits" | "openHour" | "closeHour">, msAgo: number) => new Date(lastOpen(shop) - msAgo)

    // ---- Shops, tables, menus ----------------------------------------------

    const shops: ShopDef[] = [
        {
            id: new Types.ObjectId(DEMO_SHOP_ID),
            name: "Rocketlit",
            bio: "Specialty coffee roasted ten minutes away, brunch cooked to order and cakes baked every morning, all under the railway arches. Scan the code on your table, order when you're ready and we'll bring it over.",
            open_times: "Mon–Fri 7:30–17:00 · Sat–Sun 9:00–17:00",
            phone: "0161 496 0120",
            web_URL: "https://rocketlit.example",
            cover: photo("Rocketlit"),
            tables: [
                { id: new Types.ObjectId(DEMO_TABLE_ID), name: "Fire Place 🔥" },
                { id: rng.oid(), name: "Window" },
                { id: rng.oid(), name: "Garden 1" },
                { id: rng.oid(), name: "Garden 2" },
                { id: rng.oid(), name: "Bar" },
            ],
            deletedTables: [{ id: rng.oid(), name: "Terrace", deletedAt: dayAt(3, 16, 30) }],
            items: [
                { name: "Flat White", short_description: "Double ristretto under velvety micro-foam, cut the way Melbourne taught us", description: "Two ristretto shots of our house espresso, a Brazil-Colombia blend roasted ten minutes' walk from here, under 5mm of silky steamed milk. The drink the regulars come back for.", price: 3.2, category: "drinks" },
                { name: "Latte", short_description: "Our house blend, steamed milk, latte art if you're lucky", description: "A single shot of house espresso in a generous cup of steamed milk, smooth and gentle. Oat, soya and almond at no extra charge.", price: 3.4, category: "drinks" },
                { name: "Espresso", short_description: "This week's single origin, pulled short and sweet", description: "Pulled at 18 grams in, 36 out, from a single-origin coffee that changes every week. Ask the barista what's on and they'll tell you the farm.", price: 2.6, category: "drinks" },
                { name: "Chai", short_description: "Our own masala blend simmered with oat milk, warm with cardamom and ginger", description: "Black tea simmered slowly with cardamom, ginger, cinnamon and black pepper, finished with steamed oat milk and a little honey. Spiced, not sweet.", price: 3.5, category: "drinks" },
                { name: "Fresh Orange Juice", short_description: "Valencia oranges squeezed when you order, nothing added", description: "Half a dozen Valencia oranges through the press the moment you order, into a chilled glass. Pure juice, nothing added, never from a carton.", price: 3.8, category: "drinks" },
                { name: "Sparkling Water", short_description: "Ice-cold, served with lemon, 750 ml for the table", description: "A 750 ml bottle for the table, served over ice with a slice of lemon. Still water is always free: just ask.", price: 2.2, category: "drinks" },
                { name: "Avocado Toast", short_description: "Smashed Hass avocado on toasted sourdough, poached egg, lime, chilli and pumpkin seeds", description: "Ripe Hass avocado smashed with lime and sea salt on two thick slices of toasted sourdough, a soft poached free-range egg on top, finished with chilli flakes and toasted pumpkin seeds.", price: 8.5, category: "food" },
                { name: "Sourdough Toastie", short_description: "Mature cheddar, caramelised red onion and wholegrain mustard, pressed until it pulls", description: "Thick-cut sourdough pressed with mature cheddar, slow-caramelised red onion and wholegrain mustard until the cheese pulls. Comes with a small pickle on the side.", price: 7.9, category: "food", soldOut: true },
                { name: "Shakshuka", short_description: "Two eggs baked in spiced tomato and peppers, crumbled feta, warm flatbread for dipping", description: "Two free-range eggs baked in a pan of slow-cooked tomato, red peppers, cumin and smoked paprika, with crumbled feta and coriander. Served with warm flatbread for dipping.", price: 10.5, category: "food" },
                { name: "Granola Bowl", short_description: "House-baked granola, thick Greek yoghurt, seasonal fruit and a drizzle of honey", description: "Our own granola, baked with oats, almonds and maple, over thick Greek yoghurt with whatever fruit is best this week and a drizzle of local honey.", price: 6.8, category: "food" },
                { name: "Pastel de Nata", short_description: "Baked this morning: flaky pastry, caramelised custard, a dusting of cinnamon", description: "Crisp, flaky pastry with a set custard filling caramelised on top, baked here every morning and best eaten slightly warm with a dusting of cinnamon.", price: 2.8, category: "food", launchedDaysAgo: 48 },
                { name: "Carrot Cake", short_description: "Spiced, loaded with walnuts, under a thick cream-cheese frosting", description: "A tall slice of moist spiced carrot cake with toasted walnuts and a thick layer of cream-cheese frosting. Our bestseller with a flat white.", price: 4.2, category: "food" },
                { name: "Pumpkin Soup", short_description: "Roasted pumpkin, toasted seeds, warm bread (autumn only)", description: "Slow-roasted pumpkin blended with onion and a touch of nutmeg, topped with toasted seeds and served with warm bread. On the menu for the autumn months only.", price: 6.5, category: "food", deleted: true },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 0 || dow === 6 ? [12, 16] : [6, 9]),
            openHour: 8,
            closeHour: 16,
            peaks: [[8, 10], [12, 14]],
            growth: 0.8,
            badWeek: [38, 32],
            goodWeek: [7, 1],
            since: 90,
        },
        {
            id: rng.oid(),
            name: "Marlow Street Kitchen",
            bio: "A neighbourhood kitchen cooking what's best this season: hand-picked crab, seven-hour lamb, a short list of wines we actually drink. Order from the table, share what you like, and each pay for your own dishes when you're ready to go.",
            open_times: "Tue–Sun 12:00–22:30",
            phone: "020 7946 0834",
            web_URL: "https://marlowstreet.example",
            cover: photo("Marlow Street Kitchen"),
            tables: [
                ...["Table 1", "Table 2", "Table 3", "Table 4", "Table 5", "Table 6"].map((name) => ({ id: rng.oid(), name })),
                { id: rng.oid(), name: "Counter" },
            ],
            deletedTables: [],
            items: [
                { name: "House Red", short_description: "Rioja Tempranillo, soft and full, 175 ml", description: "A Rioja Tempranillo chosen for the whole menu: ripe red fruit, soft tannins and a touch of oak. 175 ml glass; the bottle is on the wine list.", price: 6.5, category: "drinks" },
                { name: "House White", short_description: "Picpoul de Pinet, crisp and saline, 175 ml", description: "Picpoul de Pinet from the Languedoc coast, bone dry and saline: made for the crab linguine and the burrata. 175 ml glass.", price: 6.5, category: "drinks" },
                { name: "Pale Ale", short_description: "Hazy, hoppy and brewed four streets away, 440 ml", description: "A hazy pale ale brewed four streets away, bright with citrus hops and easy at 4.5%. 440 ml can, poured into a cold glass.", price: 5.8, category: "drinks" },
                { name: "Negroni", short_description: "Barrel-aged for six weeks, bitter and silky, over one big cube", description: "Equal parts gin, Campari and sweet vermouth, aged together in a small oak barrel for six weeks until the edges soften. Stirred, served over one large cube with a twist of orange.", price: 9.5, category: "drinks" },
                { name: "Lemonade", short_description: "Still lemonade made in the kitchen this morning, not too sweet", description: "Fresh lemons, a light sugar syrup and cold filtered water, made in the kitchen every morning. Served over ice with a slice.", price: 3.2, category: "drinks" },
                { name: "Espresso", short_description: "A proper after-dinner espresso, rich and short", description: "A rich, short shot of a dark-roasted Italian blend, the way it belongs after dinner. Add a splash of grappa if you're not driving.", price: 2.8, category: "drinks" },
                { name: "Burrata", short_description: "Creamy burrata torn over heritage tomatoes, basil oil and flaky salt", description: "A whole burrata torn open over a plate of heritage tomatoes at their ripest, dressed with basil oil, aged balsamic and flaky sea salt. Bread for the creamy middle.", price: 9, category: "food" },
                { name: "Crab Linguine", short_description: "Hand-picked Cornish crab, chilli, lemon and parsley through fresh linguine", description: "Fresh linguine tossed with hand-picked white and brown Cornish crab, garlic, a little chilli, lemon zest and parsley. Light, rich and gone in minutes.", price: 18.5, category: "food" },
                { name: "Lamb Shoulder", short_description: "Slow-cooked for seven hours until it falls off the bone, for two to share", description: "A whole shoulder of lamb cooked slowly for seven hours with garlic, rosemary and anchovy until it falls apart, served in its pot with roast potatoes and salsa verde. Made for two to share.", price: 22, category: "food" },
                { name: "Roast Chicken", short_description: "Half a free-range chicken, crisp-skinned, with salsa verde and roasting juices", description: "Half a free-range chicken roasted until the skin is crisp and golden, served with its roasting juices, a sharp salsa verde and a pile of greens.", price: 17.5, category: "food" },
                { name: "Mushroom Risotto", short_description: "Wild mushrooms, aged parmesan, a last swirl of butter", description: "Carnaroli rice cooked slowly with wild mushrooms, white wine and stock, finished with aged parmesan and a swirl of butter. Comforting and deep.", price: 15, category: "food", soldOut: true },
                { name: "Chips", short_description: "Triple-cooked, with rosemary salt and aioli", description: "Thick-cut potatoes cooked three times for a crisp shell and a fluffy middle, tossed in rosemary salt and served with garlic aioli.", price: 4.5, category: "food" },
                { name: "Tiramisu", short_description: "Our head chef's nonna's recipe: espresso-soaked savoiardi, mascarpone, cocoa", description: "The recipe our head chef grew up with: savoiardi soaked in strong espresso and a little marsala, layered with light mascarpone cream and finished with bitter cocoa.", price: 7, category: "food" },
                { name: "Affogato", short_description: "A scoop of vanilla gelato drowned in a hot double espresso", description: "Madagascan vanilla gelato in a cold glass, drowned at the table with a hot double espresso. Dessert and coffee in one; add amaretto if you like.", price: 5.5, category: "food" },
                { name: "Sea Bass", short_description: "Whole sea bass grilled over charcoal with lemon and herbs (summer menu)", description: "A whole sea bass grilled over charcoal and dressed with lemon, olive oil and soft herbs, served with new potatoes. A summer-menu dish.", price: 21, category: "food", deleted: true },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 1 ? null : dow === 5 || dow === 6 ? [16, 18] : [9, 10]),
            openHour: 12,
            closeHour: 22,
            peaks: [[12, 14], [18, 21]],
            growth: -0.5,
            badWeek: [7, 1],
            since: 90,
        },
        {
            id: rng.oid(),
            name: "Saturday Market Pop-up",
            bio: "Hand-folded dumplings, pillowy bao and cold-brewed tea from a stall at the Saturday market, 10 till 4 or until we sell out. Scan the code on the counter, order, and we'll shout your name.",
            open_times: "Sat 10:00–16:00",
            phone: "",
            web_URL: "",
            cover: photo("Saturday Market Pop-up"),
            tables: [{ id: rng.oid(), name: "Stall A" }, { id: rng.oid(), name: "Stall B" }],
            deletedTables: [],
            items: [
                { name: "Bao Bun", short_description: "Fluffy steamed bun, slow-braised pork belly or crispy tofu, pickles and hoisin", description: "A pillowy steamed bun stuffed with slow-braised pork belly or crispy tofu, pickled cucumber, spring onion, crushed peanuts and hoisin. Two for a proper lunch.", price: 6, category: "food" },
                { name: "Dumplings", short_description: "Six pan-fried pork and chive dumplings, crisp underneath, with black vinegar dip", description: "Six pork and chive dumplings, hand-folded this morning, pan-fried until crisp underneath and steamed on top. Served with a black vinegar and chilli dipping sauce.", price: 8, category: "food" },
                { name: "Kimchi Fries", short_description: "Crispy fries loaded with kimchi, gochujang mayo, spring onion and sesame", description: "A big portion of crispy fries buried under our own kimchi, gochujang mayo, spring onion and toasted sesame. Messy on purpose.", price: 5.5, category: "food" },
                { name: "Mochi", short_description: "Two chewy mochi, today's flavours on the board", description: "Two soft, chewy mochi filled with sweet bean or ice cream; the day's flavours are on the board. Matcha and black sesame are the regulars.", price: 3.5, category: "food", soldOut: true },
                { name: "Miso Soup", short_description: "Warming white miso broth with silken tofu, wakame and spring onion", description: "A warming white miso broth with silken tofu, wakame seaweed and spring onion. The thing to hold on a cold market morning.", price: 4, category: "food" },
                { name: "Iced Tea", short_description: "Cold-brewed jasmine tea over ice, lightly sweet", description: "Jasmine green tea cold-brewed overnight so it's smooth and never bitter, poured over ice and just lightly sweetened.", price: 3, category: "drinks" },
                { name: "Yuzu Lemonade", short_description: "Fresh lemonade sharpened with Japanese yuzu, over crushed ice", description: "Fresh-squeezed lemonade with a shot of Japanese yuzu juice for a floral, sharp finish, served over crushed ice.", price: 3, category: "drinks" },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 6 ? [16, 16] : null),
            openHour: 10,
            closeHour: 16,
            peaks: [[12, 14]],
            growth: 0.6,
            since: 20,
        },
    ]
    const shopIds = shops.map((s) => s.id)
    const tableIds = shops.flatMap((s) => [...s.tables, ...s.deletedTables].map((t) => String(t.id)))
    const menuIds = shops.flatMap((s) => s.items.map((i) => i.id))

    // ---- Users (found by email; created with a fixed id when absent) --------

    // Ids drawn up front, whether or not they're needed, so the generator's
    // sequence (and every id after) is the same on a rerun that finds the users.
    // The accounts' ids come from the sequence in the order the accounts were
    // added to the seed, newest last: a database seeded before keeps every
    // account by email with the id it was given, so an id drawn earlier in the
    // sequence for a new account would be one an older account already holds.
    const userIds = { manager: rng.oid(), frank: rng.oid(), diners: DINERS.map(() => rng.oid()), alex: rng.oid() }
    // The café's till and kitchen came after the history was shaped: their ids
    // come from a generator of their own, so drawing them shifts nothing the
    // main sequence writes (a draw from it would move every later id and date).
    const staffRng = new Rng(20261022)
    const staffIds = { kim: staffRng.oid(), jo: staffRng.oid() }
    const user = async (id: Types.ObjectId, email: string, fields: { name: string; surname: string; role: "customer" | "shopMg"; createdBy?: Types.ObjectId }, password?: string) => {
        const existing = await UserModel.findOne({ email })
        // A new address never takes an id another account holds (one seeded
        // under an earlier version of this file, or any other): a fresh one then.
        const taken = !existing && (await UserModel.exists({ _id: id }))
        const doc = existing ?? new UserModel({ _id: taken ? new Types.ObjectId() : id, email })
        doc.set(fields)
        if (!doc.avatar) doc.avatar = `https://ui-avatars.com/api/?name=${fields.name}+${fields.surname}`
        // Rehashed only when it differs (a rotation), so a rerun changes nothing.
        if (password && !(doc.password && (await bcrypt.compare(password, doc.password)))) doc.password = password
        if (doc.isModified()) await doc.save()
        return doc._id as Types.ObjectId
    }
    const managerId = await user(userIds.manager, DEMO_MANAGER_EMAIL, { name: "Sam", surname: "Demo", role: "shopMg" }, managerPassword)
    const frankId = await user(userIds.frank, DEMO_DINER_EMAIL, { name: "Frank", surname: "Demo", role: "customer" }, dinerPassword)
    // The café's second manager, added by Sam: an account with no sign-in (no
    // password, no Google), on a reserved domain so no one can claim it.
    const alexId = await user(userIds.alex, DEMO_STAFF_EMAIL, { name: "Alex", surname: "Demo", role: "customer", createdBy: managerId })
    // The café's till (added by Sam) and kitchen (added by Alex, the manager): the same kind of account.
    const kimId = await user(staffIds.kim, DEMO_TILL_EMAIL, { name: "Kim", surname: "Demo", role: "customer", createdBy: managerId })
    const joId = await user(staffIds.jo, DEMO_KITCHEN_EMAIL, { name: "Jo", surname: "Demo", role: "customer", createdBy: alexId })
    const dinerIds: Types.ObjectId[] = [frankId]
    for (const [i, d] of DINERS.entries()) {
        dinerIds.push(await user(userIds.diners[i], `${d.name.toLowerCase()}.${d.surname.toLowerCase()}@example.com`, { ...d, role: "customer" }))
    }
    const regulars = dinerIds.slice(0, REGULARS)
    const occasionals = dinerIds.slice(REGULARS)
    // The regulars were there from the start; the others each make a first
    // visit at one of the shops, spaced over its history a day or so apart
    // from the next, each on a day the shop opens (the last on its most
    // recent open day), and come now and then after. So every shop's report
    // has new faces in any month and on its latest open days, and its
    // returning share is never everyone.
    const opens = (shop: ShopDef, daysAgo: number) => !!shop.visits(weekdayOf(dayOf(daysAgo)))
    const openDayNear = (shop: ShopDef, daysAgo: number) => {
        for (let d = daysAgo; d >= 1; d--) if (opens(shop, d)) return d
        for (let d = daysAgo + 1; d <= shop.since; d++) if (opens(shop, d)) return d
        return daysAgo
    }
    const debuts = new Map<string, { shop: ShopDef; daysAgo: number; done: boolean }>()
    occasionals.forEach((id, i) => {
        const shop = shops[i % shops.length]
        const mates = occasionals.filter((_, n) => n % shops.length === i % shops.length).length
        const step = (shop.since - 4) / (mates - 1)
        const nth = Math.floor(i / shops.length)
        const spread = Math.min(shop.since - 1, Math.max(1, Math.round(2 + nth * step) + rng.int(-1, 1)))
        // The first of each shop's newcomers debuts on its most recent open day.
        debuts.set(String(id), { shop, daysAgo: openDayNear(shop, nth === 0 ? 1 : spread), done: false })
    })
    const arrivals = new Map([...debuts].map(([id, d]) => [id, d.daysAgo]))
    log(`Users: ${dinerIds.length + 4} (sign-ins: ${DEMO_MANAGER_EMAIL}, ${DEMO_DINER_EMAIL}; the café's staff ${DEMO_STAFF_EMAIL}, ${DEMO_TILL_EMAIL}, ${DEMO_KITCHEN_EMAIL} have no sign-in)`)

    // ---- Reset what the seed owns ------------------------------------------

    await CartModel.deleteMany({ $or: [{ shopId: { $in: shopIds } }, { tableId: { $in: tableIds } }] })
    await OrderModel.deleteMany({ shopId: { $in: shopIds } })
    await PaybackModel.deleteMany({ shopId: { $in: shopIds } })
    await StripeCheckoutModel.deleteMany({ $or: [{ shopId: { $in: shopIds } }, { _id: /^pi_demo_/ }] })
    await MenuModel.deleteMany({ $or: [{ _id: { $in: menuIds } }, { deletedFrom: { $in: shopIds } }] })
    await ShopModel.deleteMany({ _id: { $in: shopIds } })

    // ---- Write shops and menus ---------------------------------------------

    for (const shop of shops) {
        for (const item of shop.items) {
            const created = at((item.launchedDaysAgo ?? shop.since) * DAY + HOUR)
            await new MenuModel({
                _id: item.id,
                name: item.name,
                short_description: item.short_description,
                description: item.description,
                price: item.price,
                category: item.category,
                image: photo(item.name),
                available: !item.soldOut && !item.deleted,
                ...(item.deleted && { deletedFrom: shop.id }),
                createdAt: created,
                updatedAt: item.soldOut ? at(2 * HOUR) : created,
            }).save({ timestamps: false })
        }
        await new ShopModel({
            _id: shop.id,
            name: shop.name,
            bio: shop.bio,
            open_times: shop.open_times,
            phone: shop.phone,
            web_URL: shop.web_URL,
            cover: shop.cover,
            timeZone: zone,
            // Sam owns every shop; the café has a second manager, added a month
            // in, and a till and a kitchen added later (the staff list shows
            // every role but floor).
            shopMg: [managerId, ...(String(shop.id) === DEMO_SHOP_ID ? [alexId, kimId, joId] : [])],
            ownerId: managerId,
            members: [
                { userId: managerId, role: "owner", since: at(shop.since * DAY + 2 * HOUR) },
                ...(String(shop.id) === DEMO_SHOP_ID ? [
                    { userId: alexId, role: "manager", since: at((shop.since - 30) * DAY + 2 * HOUR), addedBy: managerId },
                    { userId: kimId, role: "till", since: at((shop.since - 45) * DAY + 2 * HOUR), addedBy: managerId },
                    { userId: joId, role: "kitchen", since: at((shop.since - 60) * DAY + 2 * HOUR), addedBy: alexId },
                ] : []),
            ],
            tables: shop.tables.map((t) => ({ _id: t.id, name: t.name, Qr_Url: `${env.FRONTEND_ORIGIN}/shops/${shop.id}/tables/${t.id}` })),
            deletedTables: shop.deletedTables.map((t) => ({ _id: t.id, name: t.name, deletedAt: t.deletedAt })),
            menu: shop.items.filter((i) => !i.deleted).map((i) => i.id),
            createdAt: at(shop.since * DAY + 2 * HOUR),
            updatedAt: at(shop.since * DAY + 2 * HOUR),
        }).save({ timestamps: false })
    }

    // ---- Carts -------------------------------------------------------------

    type Line = { item: ShopDef["items"][number]; qty: number }
    type Payer = { userId: Types.ObjectId; lines: Line[]; provider: PaymentProvider; paidAt: Date; status?: "pending" }
    type RefundSpec = { payer: Payer; line: Line; qty: number; reason: RefundReason; reasonNote?: string; at: Date; failed?: string }
    type CartSpec = {
        shop: ShopDef
        table: { id: Types.ObjectId; name: string }
        openedAt: Date
        payers: Payer[]
        // Units ordered and still unpaid (open cart), by diner.
        unpaid?: { userId: Types.ObjectId; lines: Line[]; selected?: { line: Line; qty: number; claimedAt: Date }[] }[]
        refunds?: RefundSpec[]
        closedBy?: { at: Date; dropped: Line[] }
        status: "open" | "closed"
        notices?: INotice[]
        logs?: IManagerLogEntry[]
        finishedBySweep?: boolean
        updatedAt?: Date
    }

    const specs: CartSpec[] = []
    const price = (l: Line) => l.item.price
    const sum = (lines: { qty: number; unitPrice: number }[]) => fromPence(lines.reduce((s, l) => s + toPence(l.unitPrice) * l.qty, 0))

    // The history: every day of each shop's past, a number of visits.
    for (const shop of shops) {
        for (let daysAgo = shop.since; daysAgo >= 1; daysAgo--) {
            const dow = weekdayOf(dayOf(daysAgo))
            const range = shop.visits(dow)
            if (!range) continue
            const within = (week?: [number, number]) => !!week && daysAgo <= week[0] && daysAgo >= week[1]
            const bad = within(shop.badWeek)
            // The shop's line through its days (a rise or a fall); the bad week
            // well under it, the good week over.
            const trend = (1 + shop.growth * (1 - daysAgo / shop.since)) * (bad ? 0.5 : within(shop.goodWeek) ? 1.3 : 1)
            // Whoever's first visit here is due (on the shop's next open day).
            const debutants = occasionals.filter((id) => { const d = debuts.get(String(id))!; return d.shop === shop && !d.done && d.daysAgo >= daysAgo })
            debutants.forEach((id) => { debuts.get(String(id))!.done = true })
            const visits = Math.max(debutants.length, Math.round(rng.int(range[0], range[1]) * trend))
            for (let v = 0; v < visits; v++) {
                const table = rng.pick(shop.tables.concat(daysAgo > 3 ? shop.deletedTables : []))
                // Most visits start in a peak; the rest anywhere in the hours.
                const [from, to] = rng.chance(0.65) ? rng.pick(shop.peaks) : [shop.openHour, shop.closeHour - 2]
                // No visit starts within two hours of closing, peak or not: it
                // pays within the closing hour.
                const hour = Math.min(rng.int(from, to), shop.closeHour - 2)
                const openedAt = dayAt(daysAgo, hour, rng.int(0, 59))
                const onMenu = shop.items.filter((i) => !i.soldOut && (!i.deleted || daysAgo > 30) && (i.launchedDaysAgo == null || daysAgo <= i.launchedDaysAgo))
                const lines: Line[] = rng.some(onMenu, rng.int(2, 5)).map((item) => ({ item, qty: rng.weighted([[1, 70], [2, 25], [3, 5]]) }))
                // Regulars bring most of the visits; the others, those who have
                // turned up by this day, come now and then. A first visit is
                // the newcomer's, with a regular or two along.
                const arrived = occasionals.filter((id) => arrivals.get(String(id))! >= daysAgo)
                const payerIds = v < debutants.length
                    ? [debutants[v], ...rng.some(regulars, rng.int(0, Math.min(2, lines.length - 1)))]
                    : rng.some(rng.chance(0.7) || arrived.length === 0 ? regulars : arrived, rng.int(1, Math.min(3, lines.length)))
                // Each line's units go to the payers, one line at a time.
                const payers: Payer[] = payerIds.map((userId, i) => ({
                    userId,
                    lines: lines.filter((_, n) => n % payerIds.length === i),
                    provider: rng.chance(0.6) ? "stripe" : "paypal",
                    paidAt: new Date(openedAt.getTime() + rng.int(25, 80) * MINUTE + i * rng.int(1, 6) * MINUTE),
                }))
                const spec: CartSpec = { shop, table, openedAt, payers, status: "closed", refunds: [] }
                // Refunds: a few, more on a busy Friday or Saturday evening and
                // in the bad week, when they are mostly for the wait.
                const busyEvening = (dow === 5 || dow === 6) && hour >= 18
                if (rng.chance(bad ? 0.14 : busyEvening ? 0.1 : 0.04)) {
                    const payer = rng.pick(payers)
                    const line = rng.pick(payer.lines)
                    const reason = rng.weighted<RefundReason>([
                        ["unavailable", 15], ["wrong_item", 25], ["quality", bad ? 40 : 20], ["long_wait", bad || busyEvening ? 150 : 8],
                        ["paid_by_mistake", 10], ["changed_mind", 10], ["other", 8],
                    ])
                    spec.refunds!.push({
                        payer, line, qty: 1, reason,
                        ...(reason === "other" && { reasonNote: rng.pick(["Table asked to change the order", "Spilled at the pass", "Charged for the wrong table"]) }),
                        at: new Date(payer.paidAt.getTime() + rng.int(10, 120) * MINUTE),
                        ...(rng.chance(0.12) && payer.provider === "paypal" && { failed: "The capture has already been fully refunded" }),
                    })
                }
                if (payers.some((p) => p.provider === "stripe") && rng.chance(0.03)) spec.finishedBySweep = true
                if (rng.chance(0.02)) {
                    // A manager closed it with an unpaid unit left on it.
                    const dropped = rng.pick(onMenu)
                    spec.closedBy = { at: new Date(Math.max(...payers.map((p) => p.paidAt.getTime())) + rng.int(15, 60) * MINUTE), dropped: [{ item: dropped, qty: 1 }] }
                }
                specs.push(spec)
            }
        }
    }

    // The live states, at the demo shop (Rocketlit).
    const [rocketlit, marlow] = shops
    const R = (name: string) => rocketlit.items.find((i) => i.name === name)!
    const M = (name: string) => marlow.items.find((i) => i.name === name)!
    const [ada, ben, chloe, dev, eva, grace, hugo] = dinerIds.slice(1)
    const rTable = (name: string) => rocketlit.tables.find((t) => t.name === name)!
    const mTable = (name: string) => marlow.tables.find((t) => t.name === name)!

    // Fire Place (the QR table): Ada is ordering; nothing selected or paid yet.
    specs.push({
        shop: rocketlit, table: rTable("Fire Place 🔥"), openedAt: ago(rocketlit, 25 * MINUTE), payers: [], status: "open",
        unpaid: [{ userId: ada, lines: [{ item: R("Flat White"), qty: 1 }, { item: R("Avocado Toast"), qty: 1 }] }],
    })
    // Window: Ben paid his half by card; Chloe's selection has been held 40 minutes.
    specs.push({
        shop: rocketlit, table: rTable("Window"), openedAt: ago(rocketlit, 55 * MINUTE), status: "open",
        payers: [{ userId: ben, lines: [{ item: R("Latte"), qty: 1 }, { item: R("Carrot Cake"), qty: 1 }], provider: "stripe", paidAt: ago(rocketlit, 30 * MINUTE) }],
        unpaid: [{ userId: chloe, lines: [{ item: R("Latte"), qty: 1 }, { item: R("Carrot Cake"), qty: 1 }], selected: [{ line: { item: R("Latte"), qty: 1 }, qty: 1, claimedAt: ago(rocketlit, 40 * MINUTE) }, { line: { item: R("Carrot Cake"), qty: 1 }, qty: 1, claimedAt: ago(rocketlit, 40 * MINUTE) }] }],
        notices: [{ at: ago(rocketlit, 45 * MINUTE), forUserId: chloe, message: "The staff released your selection of 1× Latte." }],
        logs: [{ at: ago(rocketlit, 45 * MINUTE), byUserId: managerId, action: "releaseSelection", details: "Chloe: 1× Latte" }],
    })
    // Garden 1: Dev paid with PayPal; a toastie sold out after it was ordered.
    specs.push({
        shop: rocketlit, table: rTable("Garden 1"), openedAt: ago(rocketlit, 70 * MINUTE), status: "open",
        payers: [{ userId: dev, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Fresh Orange Juice"), qty: 1 }], provider: "paypal", paidAt: ago(rocketlit, 45 * MINUTE) }],
        unpaid: [{ userId: eva, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Fresh Orange Juice"), qty: 1 }, { item: R("Sourdough Toastie"), qty: 1 }] }],
    })
    // Bar: Hugo's PayPal payment is held for review.
    specs.push({
        shop: rocketlit, table: rTable("Bar"), openedAt: ago(rocketlit, 35 * MINUTE), status: "open",
        payers: [{ userId: hugo, lines: [{ item: R("Chai"), qty: 2 }], provider: "paypal", paidAt: ago(rocketlit, 15 * MINUTE), status: "pending" }],
    })
    // Garden 2 two days ago: Hugo paid for the units Grace was paying for at the
    // same moment; her card payment was captured, couldn't be recorded, and
    // Stripe refused the refund (expired card): a pay-back staff still owe.
    // The dated states sit in the shops' hours, whatever the clock the seed
    // runs on; the live ones are now.
    const garden2 = { shop: rocketlit, table: rTable("Garden 2"), openedAt: dayAt(2, 12, 10), status: "closed" as const,
        payers: [{ userId: hugo, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Flat White"), qty: 1 }], provider: "stripe" as const, paidAt: dayAt(2, 12, 40) }],
        refunds: [] as RefundSpec[] }
    specs.push(garden2)
    // Terrace, deleted three days ago after closing: a cart paid that morning,
    // refunded two hours ago.
    specs.push({
        shop: rocketlit, table: rocketlit.deletedTables[0], openedAt: dayAt(3, 11, 20), status: "closed",
        payers: [{ userId: ada, lines: [{ item: R("Granola Bowl"), qty: 1 }, { item: R("Latte"), qty: 1 }], provider: "stripe", paidAt: dayAt(3, 11, 50) }],
        refunds: [],
    })
    specs.at(-1)!.refunds!.push({ payer: specs.at(-1)!.payers[0], line: specs.at(-1)!.payers[0].lines[1], qty: 1, reason: "quality", at: at(2 * HOUR) })
    // Marlow, Table 3: three diners, one has paid, two are selecting (at the latest moment it was open).
    specs.push({
        shop: marlow, table: mTable("Table 3"), openedAt: ago(marlow, 50 * MINUTE), status: "open",
        payers: [{ userId: grace, lines: [{ item: M("Crab Linguine"), qty: 1 }, { item: M("House White"), qty: 1 }], provider: "stripe", paidAt: ago(marlow, 6 * MINUTE) }],
        unpaid: [
            { userId: frankId, lines: [{ item: M("Roast Chicken"), qty: 1 }, { item: M("Pale Ale"), qty: 1 }], selected: [{ line: { item: M("Roast Chicken"), qty: 1 }, qty: 1, claimedAt: ago(marlow, 5 * MINUTE) }, { line: { item: M("Pale Ale"), qty: 1 }, qty: 1, claimedAt: ago(marlow, 5 * MINUTE) }] },
            { userId: eva, lines: [{ item: M("Burrata"), qty: 1 }, { item: M("Chips"), qty: 1 }, { item: M("Lemonade"), qty: 1 }], selected: [{ line: { item: M("Burrata"), qty: 1 }, qty: 1, claimedAt: ago(marlow, 4 * MINUTE) }] },
        ],
    })
    // Marlow, Table 6: just sat down.
    specs.push({
        shop: marlow, table: mTable("Table 6"), openedAt: ago(marlow, 10 * MINUTE), payers: [], status: "open",
        unpaid: [{ userId: ben, lines: [{ item: M("Negroni"), qty: 2 }] }],
    })
    // Marlow, twelve days ago: a manager's card refund Stripe accepted and then
    // failed; the diner was paid back by hand two days later.
    const marlowFailed: CartSpec = {
        shop: marlow, table: mTable("Table 1"), openedAt: dayAt(12, 19, 0), status: "closed",
        payers: [{ userId: chloe, lines: [{ item: M("Lamb Shoulder"), qty: 1 }, { item: M("House Red"), qty: 2 }], provider: "stripe", paidAt: dayAt(12, 19, 30) }],
        refunds: [],
    }
    marlowFailed.refunds!.push({ payer: marlowFailed.payers[0], line: marlowFailed.payers[0].lines[1], qty: 1, reason: "wrong_item", at: dayAt(12, 20, 0) })
    specs.push(marlowFailed)

    // ---- Build and save each cart ------------------------------------------

    let payments = 0
    let refunds = 0
    const orders = { created: 0, updated: 0, unchanged: 0 }
    const saved = new Map<CartSpec, ICartDocument>()
    const providerIds = (provider: PaymentProvider) =>
        provider === "stripe"
            ? { checkout: `pi_demo_${rng.hex(24)}`, payment: `ch_demo_${rng.hex(24)}` }
            : { checkout: `DEMO${rng.hex(13).toUpperCase()}`, payment: `CAP${rng.hex(14).toUpperCase()}` }

    for (const spec of specs) {
        // Subdocuments get their ids from the generator too (Mongoose would
        // draw fresh ones), so a rerun writes the same documents.
        const items = new Map<string, { _id: Types.ObjectId; menuId: Types.ObjectId; qty: number; qtyPayed: number }>()
        const add = (line: Line, paid: number) => {
            const key = String(line.item.id)
            const row = items.get(key) ?? { _id: rng.oid(), menuId: line.item.id, qty: 0, qtyPayed: 0 }
            row.qty += line.qty
            row.qtyPayed += paid
            items.set(key, row)
        }
        const split: (ISplitItem & { _id: Types.ObjectId })[] = []
        const paymentDocs: IPayment[] = []
        const refundDocs: IRefund[] = []
        const notices: INotice[] = (spec.notices ?? []).map((n) => ({ _id: rng.oid(), ...n }))
        const logs: IManagerLogEntry[] = [...(spec.logs ?? [])]
        const paypalIds: string[] = []
        const stripeIds: string[] = []
        const stripeRecords: Record<string, unknown>[] = []

        for (const payer of spec.payers) {
            const ids = providerIds(payer.provider)
            const payment: IPayment = {
                _id: rng.oid(),
                provider: payer.provider,
                status: payer.status ?? "completed",
                providerCheckoutId: ids.checkout,
                providerPaymentId: ids.payment,
                currency: "GBP",
                userId: payer.userId,
                paidAt: payer.paidAt,
                amount: sum(payer.lines.map((l) => ({ qty: l.qty, unitPrice: price(l) }))),
                lines: payer.lines.map((l) => ({ menuId: l.item.id, name: l.item.name, qty: l.qty, unitPrice: price(l), refundedQty: 0, category: l.item.category })),
            }
            for (const l of payer.lines) {
                add(l, l.qty)
                split.push({ _id: rng.oid(), userId: payer.userId, menuId: l.item.id, qty: l.qty, splitStatus: "closed", unitPrice: price(l), paidAt: payer.paidAt, claimedAt: new Date(payer.paidAt.getTime() - rng.int(2, 9) * MINUTE) })
            }
            paymentDocs.push(payment)
            payments++
            if (payer.provider === "paypal") paypalIds.push(ids.checkout)
            else {
                stripeIds.push(ids.checkout)
                stripeRecords.push({
                    _id: ids.checkout, cartId: undefined, tableId: String(spec.table.id), shopId: spec.shop.id, userId: payer.userId,
                    amount: toPence(payment.amount), state: "recorded", confirmed: true, finishedAt: payer.paidAt, paymentStatus: payment.status,
                    answered: `recorded:${payment.status}`, answeredBy: ["seed"],
                    createdAt: new Date(payer.paidAt.getTime() - 2 * MINUTE), updatedAt: payer.paidAt,
                })
                if (spec.finishedBySweep) {
                    logs.push({ at: new Date(payer.paidAt.getTime() + 2 * MINUTE), action: "stripeFinished",
                        details: `${money(payment.amount)} card payment finished by the server after the diner left (payment ${ids.checkout})` })
                }
            }
        }
        for (const u of spec.unpaid ?? []) {
            for (const l of u.lines) add(l, 0)
            for (const s of u.selected ?? []) split.push({ _id: rng.oid(), userId: u.userId, menuId: s.line.item.id, qty: s.qty, splitStatus: "open", claimedAt: s.claimedAt })
        }
        for (const r of spec.refunds ?? []) {
            const payment = paymentDocs[spec.payers.indexOf(r.payer)]
            const line = payment.lines.find((l) => String(l.menuId) === String(r.line.item.id))!
            const amount = fromPence(toPence(line.unitPrice) * r.qty)
            const refund: IRefund = {
                _id: rng.oid(),
                paymentId: payment._id!,
                lines: [{ menuId: line.menuId, name: line.name, qty: r.qty }],
                amount,
                currency: "GBP",
                status: r.failed ? "failed" : "completed",
                ...(r.failed ? { failureReason: r.failed } : { providerRefundId: r.payer.provider === "stripe" ? `re_demo_${rng.hex(24)}` : `REF${rng.hex(14).toUpperCase()}` }),
                byUserId: managerId,
                at: r.at,
                reason: r.reason,
                ...(r.reasonNote && { reasonNote: r.reasonNote }),
            }
            refundDocs.push(refund)
            refunds++
            const what = `${r.qty}× ${line.name}`
            if (!r.failed) {
                // Refunded units leave the cart and the payer's paid selection.
                line.refundedQty += r.qty
                const row = items.get(String(line.menuId))!
                row.qty -= r.qty
                row.qtyPayed -= r.qty
                const paid = split.find((s) => String(s.userId) === String(r.payer.userId) && String(s.menuId) === String(line.menuId) && s.splitStatus === "closed")!
                paid.qty -= r.qty
                notices.push({ _id: rng.oid(), at: r.at, forUserId: r.payer.userId, message: `The staff refunded ${money(amount)} for ${what}.` })
            }
            logs.push({ at: r.at, byUserId: managerId, action: "refund", details: `${money(amount)} for ${what} (payment ${payment._id})` })
        }
        if (spec.closedBy) {
            // The dropped units left the cart with the close; only the log and
            // the notice remember them.
            notices.push({ _id: rng.oid(), at: spec.closedBy.at, message: "The staff closed this table." })
            logs.push({ at: spec.closedBy.at, byUserId: managerId, action: "close", details: `dropped ${spec.closedBy.dropped.map((l) => `${l.qty}× ${l.item.name}`).join(", ")}` })
        }

        const rows = [...items.values()].filter((r) => r.qty > 0)
        const splits = split.filter((s) => s.qty > 0)
        const starter = spec.unpaid?.[0]?.userId ?? spec.payers[0]?.userId ?? ada
        const times = [spec.openedAt, ...spec.payers.map((p) => p.paidAt), ...(spec.refunds ?? []).map((r) => r.at), ...(spec.closedBy ? [spec.closedBy.at] : []), ...logs.map((l) => l.at)]
        const updatedAt = spec.updatedAt ?? new Date(Math.max(...times.map((t) => t.getTime())))
        const cart = new CartModel({
            _id: rng.oid(),
            userId: starter,
            shopId: spec.shop.id,
            tableId: String(spec.table.id),
            status: spec.status,
            items: rows,
            split: splits,
            ...(paypalIds.length && { paypalOrderIds: paypalIds }),
            ...(stripeIds.length && { stripePaymentIntentIds: stripeIds }),
            payments: paymentDocs,
            refunds: refundDocs,
            notices: notices.sort((a, b) => a.at.getTime() - b.at.getTime()),
            managerLog: logs.sort((a, b) => a.at.getTime() - b.at.getTime()),
            createdAt: spec.openedAt,
            updatedAt,
        })
        await cart.save({ timestamps: false })
        saved.set(spec, cart)
        for (const record of stripeRecords) await new StripeCheckoutModel({ ...record, cartId: cart._id }).save({ timestamps: false })
        for (const payment of paymentDocs) orders[await syncOrder(cart, payment._id, { shopId: spec.shop.id, tableName: spec.table.name })]++
    }

    // ---- The two pay-backs -------------------------------------------------

    // Garden 2: Grace's captured card payment Stripe wouldn't refund.
    {
        const cart = saved.get(garden2)!
        const intent = `pi_demo_${rng.hex(24)}`
        const owed = toPence(garden2.payers[0].lines.reduce((s, l) => s + price(l) * l.qty, 0))
        const since = garden2.payers[0].paidAt
        await new StripeCheckoutModel({
            _id: intent, cartId: cart._id, tableId: cart.tableId, shopId: rocketlit.id, userId: grace, amount: owed,
            state: "refundFailed", confirmed: true, finishedAt: at(DAY + HOUR), status: 409,
            message: "The table's cart changed while you were paying — your payment was refunded",
            refunding: true, refundFailures: 1, refundRefusedSince: since, refundRetryAt: at(DAY + HOUR), refundOwed: owed,
            staffToldAt: at(DAY + HOUR), answered: "refunded", answeredBy: ["seed"],
            createdAt: new Date(since.getTime() - 2 * MINUTE), updatedAt: at(DAY + HOUR),
        }).save({ timestamps: false })
        await PaybackModel.create({
            _id: rng.oid(), shopId: rocketlit.id, tableId: cart.tableId, cartId: cart._id, kind: "refundRefused", userId: grace,
            amount: fromPence(owed), currency: "GBP", paymentIntentId: intent, owed: true, at: at(DAY + HOUR),
        })
        await CartModel.updateOne({ _id: cart._id }, {
            $push: { managerLog: { at: at(DAY + HOUR), action: "stripeRefundFailed",
                details: `${money(fromPence(owed))} card payment by Grace: Stripe won't refund it, so they were charged (payment ${intent}). ` +
                    "Pay them back another way, unless a cart shows this payment as paid and they didn't pay again, " +
                    "or Stripe's dashboard shows they've disputed it since (their bank returns it then)." } },
        }, { timestamps: false })
    }
    // Marlow: a manager's refund Stripe accepted, then failed; paid back by hand.
    {
        const cart = saved.get(marlowFailed)!
        const refund = cart.refunds[0]
        const payment = cart.payments[0]
        await PaybackModel.create({
            _id: rng.oid(), shopId: marlow.id, tableId: cart.tableId, cartId: cart._id, kind: "refundFailed", userId: chloe,
            amount: refund.amount, paymentAmount: payment.amount, currency: "GBP", paymentIntentId: payment.providerCheckoutId, refundId: refund._id,
            at: at(12 * DAY + 2 * HOUR), doneAt: at(10 * DAY), doneByUserId: managerId, doneAs: "paidBack",
        })
        const what = `refund of ${money(refund.amount)} to Chloe for 1× House Red failed at Stripe (${EXPIRED_CARD})`
        await CartModel.updateOne({ _id: cart._id }, {
            $push: { managerLog: { $each: [
                { at: at(12 * DAY + 2 * HOUR), action: "stripeRefundFailed", details: `${what}: it wasn't reversed here, so pay the diner back another way` },
                { at: at(10 * DAY), byUserId: managerId, action: "paybackDone", details: `${money(refund.amount)} paid back to Chloe` },
            ] } },
        }, { timestamps: false })
    }

    const summary: SeedSummary = {
        shops: shops.length,
        tables: shops.reduce((n, s) => n + s.tables.length, 0),
        menuItems: menuIds.length,
        users: dinerIds.length + 4,
        carts: specs.length,
        payments,
        refunds,
        orders,
        paybacks: 2,
    }
    log(`Shops: ${summary.shops}, tables: ${summary.tables}, menu items: ${summary.menuItems}`)
    log(`Carts: ${summary.carts}, payments: ${summary.payments}, refunds: ${summary.refunds}, pay-backs: ${summary.paybacks}`)
    log(`Orders: ${orders.created} created, ${orders.updated} updated, ${orders.unchanged} already up to date`)
    return summary
}
