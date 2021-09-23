import { Request, Response, NextFunction } from "express"

export type TController = ( req: Request, res: Response, next: NextFunction) => Promise<void>