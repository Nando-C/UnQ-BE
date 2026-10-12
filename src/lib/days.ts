// Calendar days as "YYYY-MM-DD" text, the arithmetic between them, and where a
// day starts in a time zone. The sales report counts in the shop's zone
// (shops/model.ts `timeZone`): a day is the shop's day, not the server's.

export type Day = string
export type GroupBy = "day" | "week" | "month"

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

// The day as a UTC timestamp of its midnight: calendar arithmetic only, no zone.
const asUtc = (day: Day) => {
    const [, y, m, d] = DAY.exec(day) ?? []
    return Date.UTC(Number(y), Number(m) - 1, Number(d))
}
const dayOfUtc = (ms: number): Day => new Date(ms).toISOString().slice(0, 10)

// Whether `text` is a real calendar day ("2026-02-30" is not).
export const isDay = (text: string) => DAY.test(text) && Number.isFinite(asUtc(text)) && dayOfUtc(asUtc(text)) === text

export const addDays = (day: Day, n: number): Day => dayOfUtc(asUtc(day) + n * MS_PER_DAY)
// Both ends counted: daysBetween("2026-10-01", "2026-10-01") is 1.
export const daysBetween = (from: Day, to: Day) => Math.round((asUtc(to) - asUtc(from)) / MS_PER_DAY) + 1

// Weeks start on Monday.
const weekStart = (day: Day): Day => addDays(day, -((new Date(asUtc(day)).getUTCDay() + 6) % 7))
const monthStart = (day: Day): Day => `${day.slice(0, 8)}01`
const addMonths = (day: Day, n: number): Day => {
    const d = new Date(asUtc(day))
    return dayOfUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}

// The first day of the bucket `day` falls in.
export const bucketStart = (day: Day, by: GroupBy): Day => (by === "day" ? day : by === "week" ? weekStart(day) : monthStart(day))
const nextBucket = (bucket: Day, by: GroupBy): Day => (by === "month" ? addMonths(bucket, 1) : addDays(bucket, by === "week" ? 7 : 1))

// Every bucket from `from` to `to`, by its first day; the first may start
// before `from` (the Monday or the 1st), the last never after `to`.
export const bucketsOf = (from: Day, to: Day, by: GroupBy): Day[] => {
    const out: Day[] = []
    for (let bucket = bucketStart(from, by); bucket <= to; bucket = nextBucket(bucket, by)) out.push(bucket)
    return out
}

// -------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>()
const formatFor = (timeZone: string) => {
    let format = formats.get(timeZone)
    if (!format) {
        format = new Intl.DateTimeFormat("en-US", {
            timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        })
        formats.set(timeZone, format)
    }
    return format
}

// The wall clock in `timeZone` at `date`, as a UTC timestamp showing the same digits.
const wallClock = (date: Date, timeZone: string) => {
    const p: Record<string, string> = {}
    for (const part of formatFor(timeZone).formatToParts(date)) p[part.type] = part.value
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
}

// The day it is in `timeZone` at `date`.
export const dayIn = (date: Date, timeZone: string): Day => dayOfUtc(wallClock(date, timeZone))

// The instant `day` begins in `timeZone`. The zone's offset at that moment is
// read off its wall clock, twice, so the clocks changing between the guess and
// the answer still land on the right midnight.
export const startOfDay = (day: Day, timeZone: string): Date => {
    const wanted = asUtc(day)
    let guess = wanted
    for (let i = 0; i < 2; i++) guess = wanted - (wallClock(new Date(guess), timeZone) - guess)
    return new Date(guess)
}
