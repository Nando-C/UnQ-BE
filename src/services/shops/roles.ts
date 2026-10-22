// What a member of a shop may do, by role. The guards check abilities, never
// roles (auth/middlewares.ts allows), and this table is the one place a role
// becomes abilities; the OpenAPI document publishes both on every guarded
// operation (x-ability, x-roles). docs/auth.md#roles-and-ownership.

// The roles a member can hold: the owner (one per shop) and managers run the
// shop; till, floor and kitchen are the jobs below manager, peers of each other.
export const MEMBER_ROLES = ["owner", "manager", "till", "floor", "kitchen"] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]
// The roles a staff route gives: every one but owner, which only a hand-over gives.
export const GIVABLE_ROLES = MEMBER_ROLES.filter((role) => role !== "owner") as [MemberRole, ...MemberRole[]]

// Who holds each ability. shop.own is isShopOwner's (the owner alone deletes
// the shop and hands it over): in the table so the document and its test have
// one rule for every guarded operation; the guard keeps its own check.
export const ABILITIES = {
    "shop.own": ["owner"],
    "shop.edit": ["owner", "manager"],
    "menu.edit": ["owner", "manager"],
    "menu.availability": ["owner", "manager", "till", "floor", "kitchen"],
    "tables.edit": ["owner", "manager"],
    "tables.read": ["owner", "manager", "till", "floor", "kitchen"],
    "carts.fix": ["owner", "manager", "till", "floor"],
    "payments.manage": ["owner", "manager", "till"],
    "sales.read": ["owner", "manager"],
    "staff.read": ["owner", "manager", "till", "floor", "kitchen"],
} as const satisfies Record<string, readonly MemberRole[]>
export type Ability = keyof typeof ABILITIES

// An administrator holds every ability; a member holds their role's. The one
// place a role becomes abilities: were roles ever a shop's own, this would read
// the shop's table instead and nothing that calls it would change.
export const can = (role: "admin" | MemberRole | undefined, ability: Ability): boolean =>
    role === "admin" || (role !== undefined && (ABILITIES[ability] as readonly MemberRole[]).includes(role))

// The roles that hold any of these abilities, in the ladder's order (x-roles).
export const holdersOf = (abilities: readonly Ability[]): MemberRole[] =>
    MEMBER_ROLES.filter((role) => abilities.some((ability) => can(role, ability)))
