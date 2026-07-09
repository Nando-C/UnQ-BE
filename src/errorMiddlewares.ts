import { TErrorHandler } from "./typings/middlewares"

export const errorsHandler: TErrorHandler = (err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ message: err.message })
    } else {
      console.error(err)
      res.status(500).json({ message: "Generic Server Error" })
    }
  }
