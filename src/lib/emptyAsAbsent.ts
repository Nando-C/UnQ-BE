// For z.preprocess: an empty value ("", as `KEY=` in .env or `?limit=` in a
// query string) counts as absent, so its default or `optional()` applies.
export const emptyAsAbsent = (value: unknown) => (value === "" ? undefined : value)
