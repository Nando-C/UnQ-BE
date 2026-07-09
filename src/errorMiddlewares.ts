import { TErrorHandler } from "./typings/middlewares"

export const errorsHandler: TErrorHandler = (err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) {
      const body: { message: string; details?: unknown } = { message: err.message }
      if (err.details) body.details = err.details
      res.status(err.status).json(body)
    } else {
      console.error(err)
      res.status(500).json({ message: "Generic Server Error" })
    }
  }
