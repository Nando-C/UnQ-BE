import { Request, Response, NextFunction } from "express"

// Express 5 types a route param as `string | string[]` (the array form only arises
// from `*splat` wildcards). No route here uses one, so every param is a string.
export type TController = ( req: Request<Record<string, string>>, res: Response, next: NextFunction) => Promise<void | HttpError | undefined>
