import { TErrorHandler } from "./typings/middlewares"

// 4xx errors are the client's to read. A 5xx says only "Generic Server Error"
// (it may carry internals), unless it was created with `expose: true`: a
// message written for the user, e.g. a payment provider's refusal.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only recognizes error middleware when the handler declares all 4 params
export const errorsHandler: TErrorHandler = (err, req, res, next) => {
    if ((err.status >= 400 && err.status < 500) || (err.status >= 500 && err.expose === true)) {
      const body: { message: string; details?: unknown } = { message: err.message }
      if (err.details) body.details = err.details
      res.status(err.status).json(body)
    } else {
      console.error(err)
      res.status(500).json({ message: "Generic Server Error" })
    }
  }
