// Calendar days as "YYYY-MM-DD" text, the arithmetic between them, and where a
// day starts in a time zone. The sales report counts in the shop's zone
// (shops/model.ts `timeZone`): a day is the shop's day, not the server's.

export type Day = string
// How a series is bucketed.
export const GROUP_BY = ["day", "week", "month"] as const
export type GroupBy = (typeof GROUP_BY)[number]

// What the API counts in when a shop has no zone of its own.
export const DEFAULT_TIME_ZONE = "Europe/London"
// A time zone's canonical name ("europe/london" is "Europe/London", "utc" is
// "UTC"), or null for a name the runtime can't format dates in. Any IANA
// name the runtime knows is accepted, older spellings included, so a zone
// saved under one runtime stays valid under the next; it is saved under its
// canonical name, the one the database's date operators know too.
export const canonicalTimeZone = (name: string): string | null => {
    if (typeof name !== "string" || name === "") return null
    try {
        return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone
    } catch {
        return null
    }
}
export const isTimeZone = (name: string) => canonicalTimeZone(name) !== null

// The shape of a day; `isDay` says whether it is a real one.
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000

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
const bucketStart = (day: Day, by: GroupBy): Day => (by === "day" ? day : by === "week" ? weekStart(day) : monthStart(day))
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
// The wall clock in `timeZone` at `date`, "YYYY-MM-DD HH:MM".
export const clockIn = (date: Date, timeZone: string) => new Date(wallClock(date, timeZone)).toISOString().slice(0, 16).replace("T", " ")
// The weekday of a day (0 Sunday … 6 Saturday).
export const weekdayOf = (day: Day) => new Date(asUtc(day)).getUTCDay()

// The instant the clock in `timeZone` reads `hour`:`minute` on `day`. The
// zone's offset at that moment is read off its wall clock, twice, so the
// clocks changing between the guess and the answer still land on the right
// instant. A time the clocks skipped (in the hour lost going forward) is the
// instant that far past the skip on the clock as it then stands: 01:30 on
// such a night is 02:30, and midnight itself, in a zone that changes at
// 00:00, is the day's first instant, 01:00.
export const instantOf = (day: Day, hour: number, minute: number, timeZone: string): Date => {
    const wanted = asUtc(day) + hour * MS_PER_HOUR + minute * 60_000
    let guess = wanted
    for (let i = 0; i < 2; i++) guess = wanted - (wallClock(new Date(guess), timeZone) - guess)
    const read = wallClock(new Date(guess), timeZone)
    if (read < wanted) guess += wanted - read
    return new Date(guess)
}
// The instant `day` begins in `timeZone`.
export const startOfDay = (day: Day, timeZone: string): Date => instantOf(day, 0, 0, timeZone)
