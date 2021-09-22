import { Request, Response, NextFunction } from "express";
import createError from "http-errors"

export type TMiddleWareFunction = (req: Request, res: Response, next: NextFunction) => void
export type TErrorHandler = (err: createError.HttpError, req: Request, res: Response, next: NextFunction) => void