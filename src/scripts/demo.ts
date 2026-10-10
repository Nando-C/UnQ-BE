// The demo data: what `npm run seed:demo` (seedDemo.ts) writes, and what
// seedDemo.test.ts proves about it. Kept apart from the runner so the test can
// run it against the in-memory database.
//
// Three shops with menus and tables, eight diners, a manager, and 90 days of
// closed carts with payments from both providers, splits by several diners,
// refunds with reasons, and the live states a manager's page shows: an open
// cart being ordered, a stale selection, a sold-out item in a cart, a payment
// a provider holds, a diner to pay back, and a table deleted with a cart
// still refundable. Orders are written through the real sync, so the sales
// reports have data.
//
// Reproducible: every id, name, quantity and date comes from one seeded random
// generator and a reference time (`now`, rounded to the hour), so two runs in
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
import CartModel, { REFUND_REASONS, RefundReason } from "../services/carts/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"
import { syncOrder } from "../services/orders/sync"
import env from "../settings/env"
import { fromPence, money, toPence } from "../lib/money"
import { ICartDocument, IManagerLogEntry, INotice, IPayment, IRefund, ISplitItem, PaymentProvider } from "../typings/cart"

// The two ids the front end's README and its QR image point at.
export const DEMO_SHOP_ID = "6158a19282eaef10787cd6f3"
export const DEMO_TABLE_ID = "61702525cc1ec6af70a92f35"
export const DEMO_MANAGER_EMAIL = "manager@mail.com"
export const DEMO_DINER_EMAIL = "frank@mail.com"

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
    private next = mulberry32(20211109)
    float() { return this.next() }
    int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)) }
    chance(p: number) { return this.next() < p }
    pick<T>(list: readonly T[]) { return list[this.int(0, list.length - 1)] }
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

type Item = { name: string; short_description: string; price: number; category: "food" | "drinks"; soldOut?: boolean; deleted?: boolean }
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
    // The first day of its history.
    since: number
}

// A photo per shop and dish, from Wikimedia Commons (each freely licensed:
// public domain, CC0, CC BY or CC BY-SA; the author and licence are on the
// file's page, commons.wikimedia.org/wiki/File:<name>). Served resized by the
// Commons thumbnailer. Managers replace them from the app.
const PHOTOS: Record<string, string> = {
    "Rocketlit": "Beale Street Brews Counter (26499287821).jpg",
    "Marlow Street Kitchen": "DZ6 2644 Cozy candlelit dinner tables set for an intimate evening at a charming Thai restaurant.jpg",
    "Saturday Market Pop-up": "Jedburgh Easter Market 2022 street food stall and stallholder.jpg",
    "Flat White": "Flat white coffee with pretty feather pattern.jpg",
    "Latte": "Caffe Latte cup.jpg",
    "Espresso": "Gray espresso cup with amaretto.jpg",
    "Chai": "Chai Latte and Latte - The Mad Hatter.jpg",
    "Fresh Orange Juice": "Orange juice 1 edit1.jpg",
    "Sparkling Water": "Ice water with lemon.jpg",
    "Avocado Toast": "Smashed avocado & poached eggs - M&S Café 2023-12-28.jpg",
    "Sourdough Toastie": "Grilled Cheese with Texas Toast @ Horne's.jpg",
    "Shakshuka": "Shakshuka by Calliopejen1.jpg",
    "Granola Bowl": "Yogurt, fruit, granola bowl (34999358091).jpg",
    "Pastel de Nata": "Pastel De Nata.jpg",
    "Carrot Cake": "Carrot cake slice and latte - Saltmarsh Farmhouse & Cafe 2024-12-19.jpg",
    "Pumpkin Soup": "-2021-11-01 Bowl of homemade pumpkin soup, Trimingham, Norfolk.JPG",
    "House Red": "Wine being poured into a glass.jpg",
    "House White": "Celebrating with a glass of white wine in a lively bar setting.jpg",
    "Pale Ale": "Ærø India Pale Ale (28592484470).jpg",
    "Negroni": "Negroni served in Vancouver BC.jpg",
    "Lemonade": "Limonata (karaf).jpg",
    "Burrata": "Tomato salad with burrata, Limburg.jpg",
    "Crab Linguine": "RedDot Linguine Crab Meat Pasta.jpg",
    "Lamb Shoulder": "Roasted lamb shoulder in a pot, Brisbane, 2025, 01.jpg",
    "Roast Chicken": "Whole spiced chicken (roasted).jpg",
    "Mushroom Risotto": "Risotto ai funghi porcini.JPG",
    "Chips": "Hesburger French fries on a plate.jpg",
    "Tiramisu": "Tiramisu cake - Trading Post Coffee Roasters 2026-01-26.jpg",
    "Affogato": "Affogato al Caffe.jpg",
    "Sea Bass": "Grilled sea bass (7906690230).jpg",
    "Bao Bun": "Taiwanese burger .jpg",
    "Dumplings": "Gyoza (52769973678).jpg",
    "Kimchi Fries": "Vegan BBQ Boss Loaded Waffle Fries - Brewhouse & Kitchen, Worthing 2026-06-08.jpg",
    "Mochi": "Mochi Ice Cream.jpg",
    "Miso Soup": "Miso soup bowl.jpg",
    "Iced Tea": "NCI iced tea.jpg",
    "Yuzu Lemonade": "Lemonade with strawberry.jpg",
}
const photo = (subject: string, width: number) => {
    const file = PHOTOS[subject]
    if (!file) throw new Error(`No photo for ${subject}`)
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`
}

const DINERS = [
    { name: "Ada", surname: "Okafor" },
    { name: "Ben", surname: "Lindqvist" },
    { name: "Chloe", surname: "Marsh" },
    { name: "Dev", surname: "Raman" },
    { name: "Eva", surname: "Novak" },
    { name: "Grace", surname: "Achebe" },
    { name: "Hugo", surname: "Ferreira" },
] as const

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
    // The start of a day `days` ago, local time, at `hour`.
    const dayAt = (daysAgo: number, hour: number, minute = 0) => {
        const d = new Date(t0 - daysAgo * DAY)
        d.setHours(hour, minute, 0, 0)
        return d
    }

    // ---- Shops, tables, menus ----------------------------------------------

    const shops: ShopDef[] = [
        {
            id: new Types.ObjectId(DEMO_SHOP_ID),
            name: "Rocketlit",
            bio: "Coffee, brunch and cake under the railway arches. Order from your table; we bring it over.",
            open_times: "Mon–Fri 7:30–17:00 · Sat–Sun 9:00–17:00",
            phone: "0161 496 0120",
            web_URL: "https://rocketlit.example",
            cover: photo("Rocketlit", 1200),
            tables: [
                { id: new Types.ObjectId(DEMO_TABLE_ID), name: "Fire Place 🔥" },
                { id: rng.oid(), name: "Window" },
                { id: rng.oid(), name: "Garden 1" },
                { id: rng.oid(), name: "Garden 2" },
                { id: rng.oid(), name: "Bar" },
            ],
            deletedTables: [{ id: rng.oid(), name: "Terrace", deletedAt: at(3 * DAY) }],
            items: [
                { name: "Flat White", short_description: "Double shot, silky milk", price: 3.2, category: "drinks" },
                { name: "Latte", short_description: "Our house blend, steamed milk", price: 3.4, category: "drinks" },
                { name: "Espresso", short_description: "Single origin, changes weekly", price: 2.6, category: "drinks" },
                { name: "Chai", short_description: "Spiced, made with oat milk", price: 3.5, category: "drinks" },
                { name: "Fresh Orange Juice", short_description: "Squeezed to order", price: 3.8, category: "drinks" },
                { name: "Sparkling Water", short_description: "750 ml bottle for the table", price: 2.2, category: "drinks" },
                { name: "Avocado Toast", short_description: "Sourdough, lime, chilli, poached egg", price: 8.5, category: "food" },
                { name: "Sourdough Toastie", short_description: "Cheddar, red onion, mustard", price: 7.9, category: "food", soldOut: true },
                { name: "Shakshuka", short_description: "Baked eggs, peppers, feta, flatbread", price: 10.5, category: "food" },
                { name: "Granola Bowl", short_description: "Yoghurt, seasonal fruit, honey", price: 6.8, category: "food" },
                { name: "Pastel de Nata", short_description: "Baked this morning", price: 2.8, category: "food" },
                { name: "Carrot Cake", short_description: "Walnuts, cream cheese icing", price: 4.2, category: "food" },
                { name: "Pumpkin Soup", short_description: "With toasted seeds (autumn only)", price: 6.5, category: "food", deleted: true },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 0 || dow === 6 ? [6, 9] : [3, 5]),
            openHour: 8,
            closeHour: 16,
            since: 90,
        },
        {
            id: rng.oid(),
            name: "Marlow Street Kitchen",
            bio: "Seasonal plates and a short wine list. Pay for your own dishes when you're ready to go.",
            open_times: "Tue–Sun 12:00–22:30",
            phone: "020 7946 0834",
            web_URL: "https://marlowstreet.example",
            cover: photo("Marlow Street Kitchen", 1200),
            tables: [
                ...["Table 1", "Table 2", "Table 3", "Table 4", "Table 5", "Table 6"].map((name) => ({ id: rng.oid(), name })),
                { id: rng.oid(), name: "Counter" },
            ],
            deletedTables: [],
            items: [
                { name: "House Red", short_description: "Tempranillo, 175 ml", price: 6.5, category: "drinks" },
                { name: "House White", short_description: "Picpoul, 175 ml", price: 6.5, category: "drinks" },
                { name: "Pale Ale", short_description: "Local, 440 ml can", price: 5.8, category: "drinks" },
                { name: "Negroni", short_description: "Our barrel-aged version", price: 9.5, category: "drinks" },
                { name: "Lemonade", short_description: "Still, made here", price: 3.2, category: "drinks" },
                { name: "Espresso", short_description: "After dinner", price: 2.8, category: "drinks" },
                { name: "Burrata", short_description: "Heritage tomatoes, basil oil", price: 9, category: "food" },
                { name: "Crab Linguine", short_description: "Chilli, lemon, parsley", price: 18.5, category: "food" },
                { name: "Lamb Shoulder", short_description: "Slow-cooked, for sharing", price: 22, category: "food" },
                { name: "Roast Chicken", short_description: "Half bird, salsa verde", price: 17.5, category: "food" },
                { name: "Mushroom Risotto", short_description: "Wild mushrooms, parmesan", price: 15, category: "food", soldOut: true },
                { name: "Chips", short_description: "Rosemary salt", price: 4.5, category: "food" },
                { name: "Tiramisu", short_description: "The classic", price: 7, category: "food" },
                { name: "Affogato", short_description: "Vanilla ice cream, espresso", price: 5.5, category: "food" },
                { name: "Sea Bass", short_description: "Whole, grilled (summer menu)", price: 21, category: "food", deleted: true },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 1 ? null : dow === 5 || dow === 6 ? [8, 11] : [4, 7]),
            openHour: 12,
            closeHour: 22,
            since: 90,
        },
        {
            id: rng.oid(),
            name: "Saturday Market Pop-up",
            bio: "Bao, dumplings and iced tea from a stall at the Saturday market. Scan the code on the counter.",
            open_times: "Sat 10:00–16:00",
            phone: "",
            web_URL: "",
            cover: photo("Saturday Market Pop-up", 1200),
            tables: [{ id: rng.oid(), name: "Stall A" }, { id: rng.oid(), name: "Stall B" }],
            deletedTables: [],
            items: [
                { name: "Bao Bun", short_description: "Pork belly or tofu", price: 6, category: "food" },
                { name: "Dumplings", short_description: "Six, pan-fried", price: 8, category: "food" },
                { name: "Kimchi Fries", short_description: "Gochujang mayo", price: 5.5, category: "food" },
                { name: "Mochi", short_description: "Two, today's flavours", price: 3.5, category: "food", soldOut: true },
                { name: "Miso Soup", short_description: "With tofu and wakame", price: 4, category: "food" },
                { name: "Iced Tea", short_description: "Jasmine, lightly sweet", price: 3, category: "drinks" },
                { name: "Yuzu Lemonade", short_description: "Still, with yuzu", price: 3, category: "drinks" },
            ].map((item): ShopDef["items"][number] => ({ ...(item as Item), id: rng.oid() })),
            visits: (dow) => (dow === 6 ? [10, 16] : null),
            openHour: 10,
            closeHour: 16,
            since: 20,
        },
    ]
    const shopIds = shops.map((s) => s.id)
    const tableIds = shops.flatMap((s) => [...s.tables, ...s.deletedTables].map((t) => String(t.id)))
    const menuIds = shops.flatMap((s) => s.items.map((i) => i.id))

    // ---- Users (found by email; created with a fixed id when absent) --------

    // Ids drawn up front, whether or not they're needed, so the generator's
    // sequence (and every id after) is the same on a rerun that finds the users.
    const userIds = { manager: rng.oid(), frank: rng.oid(), diners: DINERS.map(() => rng.oid()) }
    const user = async (id: Types.ObjectId, email: string, fields: { name: string; surname: string; role: "customer" | "shopMg" }, password?: string) => {
        const existing = await UserModel.findOne({ email })
        const doc = existing ?? new UserModel({ _id: id, email })
        doc.set(fields)
        if (!doc.avatar) doc.avatar = `https://ui-avatars.com/api/?name=${fields.name}+${fields.surname}`
        // Rehashed only when it differs (a rotation), so a rerun changes nothing.
        if (password && !(doc.password && (await bcrypt.compare(password, doc.password)))) doc.password = password
        if (doc.isModified()) await doc.save()
        return doc._id as Types.ObjectId
    }
    const managerId = await user(userIds.manager, DEMO_MANAGER_EMAIL, { name: "Sam", surname: "Demo", role: "shopMg" }, managerPassword)
    const frankId = await user(userIds.frank, DEMO_DINER_EMAIL, { name: "Frank", surname: "Demo", role: "customer" }, dinerPassword)
    const dinerIds: Types.ObjectId[] = [frankId]
    for (const [i, d] of DINERS.entries()) {
        dinerIds.push(await user(userIds.diners[i], `${d.name.toLowerCase()}.${d.surname.toLowerCase()}@example.com`, { ...d, role: "customer" }))
    }
    log(`Users: ${dinerIds.length + 1} (sign-ins: ${DEMO_MANAGER_EMAIL}, ${DEMO_DINER_EMAIL})`)

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
            await new MenuModel({
                _id: item.id,
                name: item.name,
                short_description: item.short_description,
                price: item.price,
                category: item.category,
                image: photo(item.name, 800),
                available: !item.soldOut && !item.deleted,
                ...(item.deleted && { deletedFrom: shop.id }),
                createdAt: at(shop.since * DAY + HOUR),
                updatedAt: at(item.soldOut ? 2 * HOUR : shop.since * DAY + HOUR),
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
            shopMg: [managerId],
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
            const dow = dayAt(daysAgo, 12).getDay()
            const range = shop.visits(dow)
            if (!range) continue
            const visits = rng.int(range[0], range[1])
            for (let v = 0; v < visits; v++) {
                const table = rng.pick(shop.tables.concat(daysAgo > 3 ? shop.deletedTables : []))
                const openedAt = dayAt(daysAgo, rng.int(shop.openHour, shop.closeHour - 2), rng.int(0, 59))
                const onMenu = shop.items.filter((i) => !i.soldOut && (!i.deleted || daysAgo > 30))
                const lines: Line[] = rng.some(onMenu, rng.int(2, 5)).map((item) => ({ item, qty: rng.int(1, 3) }))
                const payerIds = rng.some(dinerIds, rng.int(1, Math.min(3, lines.length)))
                // Each line's units go to the payers, one line at a time.
                const payers: Payer[] = payerIds.map((userId, i) => ({
                    userId,
                    lines: lines.filter((_, n) => n % payerIds.length === i),
                    provider: rng.chance(0.6) ? "stripe" : "paypal",
                    paidAt: new Date(openedAt.getTime() + rng.int(25, 80) * MINUTE + i * rng.int(1, 6) * MINUTE),
                }))
                const spec: CartSpec = { shop, table, openedAt, payers, status: "closed", refunds: [] }
                if (rng.chance(0.06)) {
                    const payer = rng.pick(payers)
                    const line = rng.pick(payer.lines)
                    const reason = rng.pick(REFUND_REASONS)
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
        shop: rocketlit, table: rTable("Fire Place 🔥"), openedAt: at(25 * MINUTE), payers: [], status: "open",
        unpaid: [{ userId: ada, lines: [{ item: R("Flat White"), qty: 1 }, { item: R("Avocado Toast"), qty: 1 }] }],
    })
    // Window: Ben paid his half by card; Chloe's selection has been held 40 minutes.
    specs.push({
        shop: rocketlit, table: rTable("Window"), openedAt: at(55 * MINUTE), status: "open",
        payers: [{ userId: ben, lines: [{ item: R("Latte"), qty: 1 }, { item: R("Carrot Cake"), qty: 1 }], provider: "stripe", paidAt: at(30 * MINUTE) }],
        unpaid: [{ userId: chloe, lines: [{ item: R("Latte"), qty: 1 }, { item: R("Carrot Cake"), qty: 1 }], selected: [{ line: { item: R("Latte"), qty: 1 }, qty: 1, claimedAt: at(40 * MINUTE) }, { line: { item: R("Carrot Cake"), qty: 1 }, qty: 1, claimedAt: at(40 * MINUTE) }] }],
        notices: [{ at: at(45 * MINUTE), forUserId: chloe, message: "The staff released your selection of 1× Latte." }],
        logs: [{ at: at(45 * MINUTE), byUserId: managerId, action: "releaseSelection", details: "Chloe: 1× Latte" }],
    })
    // Garden 1: Dev paid with PayPal; a toastie sold out after it was ordered.
    specs.push({
        shop: rocketlit, table: rTable("Garden 1"), openedAt: at(70 * MINUTE), status: "open",
        payers: [{ userId: dev, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Fresh Orange Juice"), qty: 1 }], provider: "paypal", paidAt: at(45 * MINUTE) }],
        unpaid: [{ userId: eva, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Fresh Orange Juice"), qty: 1 }, { item: R("Sourdough Toastie"), qty: 1 }] }],
    })
    // Bar: Hugo's PayPal payment is held for review.
    specs.push({
        shop: rocketlit, table: rTable("Bar"), openedAt: at(35 * MINUTE), status: "open",
        payers: [{ userId: hugo, lines: [{ item: R("Chai"), qty: 2 }], provider: "paypal", paidAt: at(15 * MINUTE), status: "pending" }],
    })
    // Garden 2 two days ago: Hugo paid for the units Grace was paying for at the
    // same moment; her card payment was captured, couldn't be recorded, and
    // Stripe refused the refund (expired card): a pay-back staff still owe.
    const garden2 = { shop: rocketlit, table: rTable("Garden 2"), openedAt: at(2 * DAY + 3 * HOUR), status: "closed" as const,
        payers: [{ userId: hugo, lines: [{ item: R("Shakshuka"), qty: 1 }, { item: R("Flat White"), qty: 1 }], provider: "stripe" as const, paidAt: at(2 * DAY + 2 * HOUR) }],
        refunds: [] as RefundSpec[] }
    specs.push(garden2)
    // Terrace, deleted three days ago: a cart paid before, refunded two hours ago.
    specs.push({
        shop: rocketlit, table: rocketlit.deletedTables[0], openedAt: at(3 * DAY + 4 * HOUR), status: "closed",
        payers: [{ userId: ada, lines: [{ item: R("Granola Bowl"), qty: 1 }, { item: R("Latte"), qty: 1 }], provider: "stripe", paidAt: at(3 * DAY + 3 * HOUR) }],
        refunds: [],
    })
    specs.at(-1)!.refunds!.push({ payer: specs.at(-1)!.payers[0], line: specs.at(-1)!.payers[0].lines[1], qty: 1, reason: "quality", at: at(2 * HOUR) })
    // Marlow, Table 3: three diners, one has paid, two are selecting right now.
    specs.push({
        shop: marlow, table: mTable("Table 3"), openedAt: at(50 * MINUTE), status: "open",
        payers: [{ userId: grace, lines: [{ item: M("Crab Linguine"), qty: 1 }, { item: M("House White"), qty: 1 }], provider: "stripe", paidAt: at(6 * MINUTE) }],
        unpaid: [
            { userId: frankId, lines: [{ item: M("Roast Chicken"), qty: 1 }, { item: M("Pale Ale"), qty: 1 }], selected: [{ line: { item: M("Roast Chicken"), qty: 1 }, qty: 1, claimedAt: at(5 * MINUTE) }, { line: { item: M("Pale Ale"), qty: 1 }, qty: 1, claimedAt: at(5 * MINUTE) }] },
            { userId: eva, lines: [{ item: M("Burrata"), qty: 1 }, { item: M("Chips"), qty: 1 }, { item: M("Lemonade"), qty: 1 }], selected: [{ line: { item: M("Burrata"), qty: 1 }, qty: 1, claimedAt: at(4 * MINUTE) }] },
        ],
    })
    // Marlow, Table 6: just sat down.
    specs.push({
        shop: marlow, table: mTable("Table 6"), openedAt: at(10 * MINUTE), payers: [], status: "open",
        unpaid: [{ userId: ben, lines: [{ item: M("Negroni"), qty: 2 }] }],
    })
    // Marlow, twelve days ago: a manager's card refund Stripe accepted and then
    // failed; the diner was paid back by hand two days later.
    const marlowFailed: CartSpec = {
        shop: marlow, table: mTable("Table 1"), openedAt: at(12 * DAY + 5 * HOUR), status: "closed",
        payers: [{ userId: chloe, lines: [{ item: M("Lamb Shoulder"), qty: 1 }, { item: M("House Red"), qty: 2 }], provider: "stripe", paidAt: at(12 * DAY + 4 * HOUR) }],
        refunds: [],
    }
    marlowFailed.refunds!.push({ payer: marlowFailed.payers[0], line: marlowFailed.payers[0].lines[1], qty: 1, reason: "wrong_item", at: at(12 * DAY + 3 * HOUR) })
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
        const since = at(2 * DAY + 2 * HOUR)
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
        users: dinerIds.length + 1,
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
